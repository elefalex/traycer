import { readFile, writeFile } from "node:fs/promises";
import type { RecordedFrame } from "./recorder";

function scrubValue(value: unknown, keyName: string, homeDir: string): unknown {
  if (typeof value === "string") {
    if (keyName.toLowerCase() === "token") return "<redacted-token>";
    return homeDir.length > 0 ? value.split(homeDir).join("<home>") : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, "", homeDir));
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

export function scrubFrame(frame: RecordedFrame, homeDir: string): RecordedFrame {
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
