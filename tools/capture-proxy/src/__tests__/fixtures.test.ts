import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listJsonlFilesRecursively } from "./fixture-files";
import {
  assertNoResidualEmails,
  assertNoResidualSecrets,
  UNREDACTED_SECRET_JSON_PATTERN,
} from "../secret-rule";

const fixturesDir = join(__dirname, "..", "..", "fixtures");
const fixtureFiles = listJsonlFilesRecursively(fixturesDir);

describe("committed fixtures", () => {
  // Self-skips (rather than fails) until the manual runbook has produced at
  // least one fixture. Every `.jsonl` fixture found anywhere under
  // `fixtures/` is guarded — not a single hardcoded filename, and not only
  // the top level, since the runbook produces more than one recording and
  // they may be filed into subdirectories.
  //
  // The walk is imported from `../secret-rule` rather than reimplemented
  // here: the scrubber applies the same module's rule, so the gate cannot
  // silently drift from what actually ran over the recording.
  it.skipIf(fixtureFiles.length === 0)(
    "contains no residual credentials",
    async () => {
      for (const fixtureFile of fixtureFiles) {
        const text = await readFile(fixtureFile, "utf8");
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

  // PII gate, separate from the credential gate so a failure says which of
  // the two rules a fixture tripped. Same import discipline: the walk comes
  // from ../secret-rule, built on the exact pattern the scrubber redacts
  // with, so the gate cannot pass something the scrubber missed.
  //
  // There is no serialized-text companion check here, unlike the credential
  // gate above. `expect(text).not.toMatch(EMAIL_ADDRESS_PATTERN)` prints the
  // whole non-matching frame on failure — it would dump the operator's
  // address into the CI log, republishing the PII the gate is meant to
  // withhold. The walk is complete for a value-based rule anyway (it visits
  // every string in the frame, keys included) and reports a path only.
  it.skipIf(fixtureFiles.length === 0)(
    "contains no residual email addresses",
    async () => {
      for (const fixtureFile of fixtureFiles) {
        const text = await readFile(fixtureFile, "utf8");
        for (const line of text.trim().split("\n")) {
          const frame: unknown = JSON.parse(line);
          assertNoResidualEmails(frame, "");
        }
      }
    },
  );
});

describe("listJsonlFilesRecursively", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cap-fixtures-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds a .jsonl nested in a subdirectory, not just the top level", async () => {
    await mkdir(join(dir, "boot", "run-2"), { recursive: true });
    await writeFile(join(dir, "top.jsonl"), "{}\n", "utf8");
    await writeFile(join(dir, "boot", "run-2", "deep.jsonl"), "{}\n", "utf8");

    expect(listJsonlFilesRecursively(dir)).toEqual([
      join(dir, "boot", "run-2", "deep.jsonl"),
      join(dir, "top.jsonl"),
    ]);
  });

  it("ignores non-.jsonl files at every level", async () => {
    await mkdir(join(dir, "notes"), { recursive: true });
    await writeFile(join(dir, ".gitkeep"), "", "utf8");
    await writeFile(join(dir, "notes", "README.md"), "hi", "utf8");
    await writeFile(join(dir, "notes", "raw.json"), "{}", "utf8");

    expect(listJsonlFilesRecursively(dir)).toEqual([]);
  });

  it("returns nothing for a directory that does not exist", () => {
    expect(listJsonlFilesRecursively(join(dir, "absent"))).toEqual([]);
  });
});
