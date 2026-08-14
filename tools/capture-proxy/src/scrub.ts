import { readFile, writeFile } from "node:fs/promises";
import type { RecordedFrame } from "./recorder";
import {
  createWorkspaceAliases,
  isSecretKey,
  redactEmailAddresses,
  redactWorkspacePaths,
  REDACTION_SENTINEL,
  type WorkspaceAliases,
} from "./secret-rule";

// Traversal deliberately mirrors `assertNoResidualSecrets` in ./secret-rule:
// a string under a secret key is redacted, an array under a secret key is
// judged element-by-element (so `keyName` is threaded through), and an
// object is descended into with each child judged by its own key — which is
// what lets the structured non-secrets (`token: { vars }`, `apiKey:
// { supported, ... }`) through untouched.
//
// Four rules compose on a string, in this order:
//  1. Credential (key-based) — wins outright and returns early. A credential
//     is replaced whole, never partially: emitting
//     `"<redacted-email>.<signature>"` for a token that happens to embed an
//     address would publish every part the email rule did not cover.
//  2. Home directory (substring) — the operator's path prefix.
//  3. Workspace path (substring, value-based) — the private project names left
//     behind under `<home>/`. Runs immediately after the home substitution
//     because it matches only what that substitution produced, and BEFORE the
//     email rule so a path is judged as one path: an address-shaped segment
//     (`<home>/Projects/a@b.com/src`) is swallowed by the workspace
//     placeholder rather than being split into `<home>/Projects/` +
//     `<redacted-email>` + a surviving tail.
//  4. Email address (substring, value-based) — applied to every surviving
//     string whatever its key, since addresses turn up in free text and in
//     fields no key list would have named. Runs after the home substitution
//     so both land on the same string; neither can create or destroy a match
//     for the other (`<home>` carries no `@`, and a path separator cannot
//     appear inside an address match), and `<workspace-N>` carries no `@`
//     either.
function scrubValue(
  value: unknown,
  keyName: string,
  homeDir: string,
  workspaceAliases: WorkspaceAliases,
): unknown {
  if (typeof value === "string") {
    if (isSecretKey(keyName)) return REDACTION_SENTINEL;
    const withoutHome =
      homeDir.length > 0 ? value.split(homeDir).join("<home>") : value;
    const withoutWorkspaces = redactWorkspacePaths(
      withoutHome,
      workspaceAliases,
    );
    return redactEmailAddresses(withoutWorkspaces);
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      scrubValue(item, keyName, homeDir, workspaceAliases),
    );
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = scrubValue(v, k, homeDir, workspaceAliases);
    }
    return out;
  }
  return value;
}

/**
 * `workspaceAliases` is passed in rather than created here so a caller can
 * scrub a whole recording against ONE table: the same workspace path must come
 * out as the same `<workspace-N>` in every frame of a file, or two frames that
 * referred to the same directory stop matching each other on replay. Callers
 * scrubbing a single standalone frame pass `createWorkspaceAliases()`.
 */
export function scrubFrame(
  frame: RecordedFrame,
  homeDir: string,
  workspaceAliases: WorkspaceAliases,
): RecordedFrame {
  return {
    ...frame,
    payload: scrubValue(frame.payload, "", homeDir, workspaceAliases),
  };
}

export async function scrubRecording(input: {
  inPath: string;
  outPath: string;
  homeDir: string;
}): Promise<{ count: number }> {
  const lines = (await readFile(input.inPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0);
  // One table for the whole file, and a fresh one per call: workspace numbers
  // are per-recording, so `<workspace-1>` means one thing within this output
  // and nothing across files.
  const workspaceAliases = createWorkspaceAliases();
  const scrubbed = lines.map((line) => {
    const frame = JSON.parse(line) as RecordedFrame;
    return JSON.stringify(scrubFrame(frame, input.homeDir, workspaceAliases));
  });
  await writeFile(input.outPath, `${scrubbed.join("\n")}\n`, "utf8");
  return { count: scrubbed.length };
}
