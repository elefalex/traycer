import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const fixturesDir = join(__dirname, "..", "..", "fixtures");
const fixtureFiles = existsSync(fixturesDir)
  ? readdirSync(fixturesDir).filter((name) => name.endsWith(".jsonl"))
  : [];

/**
 * Confirms a value found under a key named `token` is exactly the redaction
 * sentinel. Arrays under a `token` key are checked element-by-element, since
 * `{ token: ["jwt1", "jwt2"] }` serializes with a `[` immediately after
 * `"token":`, which the regex guard below cannot see. A non-string,
 * non-array token value (a number or object) is a known, accepted gap in
 * `scrubFrame` (it only redacts string values) — such a value must never
 * ship in a committed fixture, so it is a hard failure here rather than a
 * silent pass.
 */
function assertTokenValueRedacted(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (value !== "<redacted-token>") {
      throw new Error(`unredacted token string at ${path}: ${JSON.stringify(value)}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertTokenValueRedacted(item, `${path}[${index}]`));
    return;
  }
  throw new Error(
    `token value at ${path} is a ${typeof value}, not a redacted string - ` +
      `scrubFrame only redacts string token values, so this fixture must not be committed`,
  );
}

/** Recursively walks a parsed frame, checking every value under a key named `token` (case-insensitive, matching scrubFrame's own matching rule). */
function assertNoResidualTokens(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoResidualTokens(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path.length > 0 ? `${path}.${key}` : key;
      if (key.toLowerCase() === "token") {
        assertTokenValueRedacted(child, childPath);
      } else {
        assertNoResidualTokens(child, childPath);
      }
    }
  }
}

describe("committed fixtures", () => {
  // Self-skips (rather than fails) until the manual runbook has produced at
  // least one fixture. Every `.jsonl` fixture found is guarded, not a single
  // hardcoded filename, since the runbook produces more than one recording.
  it.skipIf(fixtureFiles.length === 0)("contains no residual bearer tokens", async () => {
    for (const fixtureFile of fixtureFiles) {
      const text = await readFile(join(fixturesDir, fixtureFile), "utf8");
      for (const line of text.trim().split("\n")) {
        const frame: unknown = JSON.parse(line);
        const json = JSON.stringify(frame);
        expect(json).not.toMatch(/"token":"(?!<redacted-token>)/);
        assertNoResidualTokens(frame, "");
      }
    }
  });
});
