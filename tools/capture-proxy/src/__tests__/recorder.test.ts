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

  it("handles concurrent appends without awaiting between them", async () => {
    const file = join(dir, "rec.jsonl");
    const recorder = new Recorder(file);
    await Promise.all([
      recorder.append(frame({ ts: 1, connId: "c1" })),
      recorder.append(frame({ ts: 2, connId: "c2" })),
      recorder.append(frame({ ts: 3, connId: "c3" })),
    ]);
    await recorder.close();

    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    // Verify all lines are valid JSON
    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed).toHaveLength(3);
    // Verify all frames are present (connIds should be c1, c2, c3 in some order)
    const connIds = parsed.map((p) => p.connId).sort();
    expect(connIds).toEqual(["c1", "c2", "c3"]);
  });

  it("close() with zero appends resolves without creating a stream", async () => {
    const file = join(dir, "rec.jsonl");
    const recorder = new Recorder(file);
    await recorder.close();

    // File should not exist since we never appended
    try {
      await readFile(file, "utf8");
      expect.fail("File should not exist");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });
});
