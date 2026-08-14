import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoResidualSecrets,
  UNREDACTED_SECRET_JSON_PATTERN,
} from "../secret-rule";

const fixturesDir = join(__dirname, "..", "..", "fixtures");
const fixtureFiles = existsSync(fixturesDir)
  ? readdirSync(fixturesDir).filter((name) => name.endsWith(".jsonl"))
  : [];

describe("committed fixtures", () => {
  // Self-skips (rather than fails) until the manual runbook has produced at
  // least one fixture. Every `.jsonl` fixture found is guarded, not a single
  // hardcoded filename, since the runbook produces more than one recording.
  //
  // The walk is imported from `../secret-rule` rather than reimplemented
  // here: the scrubber applies the same module's rule, so the gate cannot
  // silently drift from what actually ran over the recording.
  it.skipIf(fixtureFiles.length === 0)(
    "contains no residual credentials",
    async () => {
      for (const fixtureFile of fixtureFiles) {
        const text = await readFile(join(fixturesDir, fixtureFile), "utf8");
        for (const line of text.trim().split("\n")) {
          const frame: unknown = JSON.parse(line);
          // Cheap independent check on the serialized form, covering the
          // plain `"token":"..."` case regardless of the walk. The pattern
          // comes from ../secret-rule so it always covers exactly the key
          // names the scrubber redacts. The walk below is the thorough one
          // (it also sees arrays, which serialize with a `[` this pattern
          // cannot match).
          expect(JSON.stringify(frame)).not.toMatch(
            UNREDACTED_SECRET_JSON_PATTERN,
          );
          assertNoResidualSecrets(frame, "");
        }
      }
    },
  );
});
