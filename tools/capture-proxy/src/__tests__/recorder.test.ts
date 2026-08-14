import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Recorder, type RecordedFrame } from "../recorder";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cap-rec-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function frame(overrides: Partial<RecordedFrame>): RecordedFrame {
  return {
    ts: 1,
    connId: "c1",
    leg: "rpc",
    direction: "c2h",
    kind: "request",
    method: "host.status",
    schemaVersion: { major: 1, minor: 0 },
    payload: {},
    ...overrides,
  };
}

describe("Recorder", () => {
  it("writes one JSON object per line, in order", async () => {
    const file = join(dir, "rec.jsonl");
    const recorder = new Recorder(file);
    await recorder.append(frame({ ts: 1 }));
    await recorder.append(frame({ ts: 2, direction: "h2c", kind: "response" }));
    await recorder.close();

    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).ts).toBe(1);
    expect(JSON.parse(lines[1]).kind).toBe("response");
  });
});
