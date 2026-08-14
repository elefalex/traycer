import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { scrubRecording } from "./scrub";

async function run(): Promise<void> {
  const { values } = parseArgs({
    options: { in: { type: "string" }, out: { type: "string" } },
  });
  const inPath = values.in;
  const outPath = values.out;
  if (typeof inPath !== "string" || typeof outPath !== "string") {
    throw new Error("Usage: scrub-cli.ts --in <raw.jsonl> --out <scrubbed.jsonl>");
  }
  const { count } = await scrubRecording({ inPath, outPath, homeDir: homedir() });
  process.stdout.write(`scrubbed ${count} frames -> ${outPath}\n`);
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
