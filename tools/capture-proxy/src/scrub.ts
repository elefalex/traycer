import { readFile, writeFile } from "node:fs/promises";
import type { RecordedFrame } from "./recorder";
import {
  isSecretKey,
  redactEmailAddresses,
  REDACTION_SENTINEL,
} from "./secret-rule";

// Traversal deliberately mirrors `assertNoResidualSecrets` in ./secret-rule:
// a string under a secret key is redacted, an array under a secret key is
// judged element-by-element (so `keyName` is threaded through), and an
// object is descended into with each child judged by its own key — which is
// what lets the structured non-secrets (`token: { vars }`, `apiKey:
// { supported, ... }`) through untouched.
//
// Three rules compose on a string, in this order:
//  1. Credential (key-based) — wins outright and returns early. A credential
//     is replaced whole, never partially: emitting
//     `"<redacted-email>.<signature>"` for a token that happens to embed an
//     address would publish every part the email rule did not cover.
//  2. Home directory (substring) — the operator's path prefix.
//  3. Email address (substring, value-based) — applied to every surviving
//     string whatever its key, since addresses turn up in free text and in
//     fields no key list would have named. Runs after the home substitution
//     so both land on the same string; neither can create or destroy a match
//     for the other (`<home>` carries no `@`, and a path separator cannot
//     appear inside an address match).
function scrubValue(value: unknown, keyName: string, homeDir: string): unknown {
  if (typeof value === "string") {
    if (isSecretKey(keyName)) return REDACTION_SENTINEL;
    const withoutHome =
      homeDir.length > 0 ? value.split(homeDir).join("<home>") : value;
    return redactEmailAddresses(withoutHome);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, keyName, homeDir));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = scrubValue(v, k, homeDir);
    }
    return out;
  }
  return value;
}

export function scrubFrame(
  frame: RecordedFrame,
  homeDir: string,
): RecordedFrame {
  return { ...frame, payload: scrubValue(frame.payload, "", homeDir) };
}

export async function scrubRecording(input: {
  inPath: string;
  outPath: string;
  homeDir: string;
}): Promise<{ count: number }> {
  const lines = (await readFile(input.inPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const scrubbed = lines.map((line) => {
    const frame = JSON.parse(line) as RecordedFrame;
    return JSON.stringify(scrubFrame(frame, input.homeDir));
  });
  await writeFile(input.outPath, `${scrubbed.join("\n")}\n`, "utf8");
  return { count: scrubbed.length };
}
