import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSessionSummary, readRealMetadata } from "../main";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cap-main-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readRealMetadata", () => {
  it("derives the /stream url from a valid /rpc websocketUrl", async () => {
    const pidPath = join(dir, "pid.json");
    await writeFile(
      pidPath,
      JSON.stringify({
        hostId: "real-host-1",
        version: "1.2.3",
        websocketUrl: "ws://127.0.0.1:51234/rpc",
      }),
      "utf8",
    );

    const real = await readRealMetadata(pidPath);

    expect(real.rpcUrl).toBe("ws://127.0.0.1:51234/rpc");
    expect(real.streamUrl).toBe("ws://127.0.0.1:51234/stream");
  });

  it("rejects a websocketUrl that does not end in /rpc instead of silently deriving an identical streamUrl", async () => {
    const pidPath = join(dir, "pid.json");
    await writeFile(
      pidPath,
      JSON.stringify({
        hostId: "real-host-1",
        version: "1.2.3",
        websocketUrl: "ws://127.0.0.1:51234/other",
      }),
      "utf8",
    );

    await expect(readRealMetadata(pidPath)).rejects.toThrow(
      /unexpected websocketUrl/,
    );
  });

  it("rejects a non-loopback host", async () => {
    const pidPath = join(dir, "pid.json");
    await writeFile(
      pidPath,
      JSON.stringify({
        hostId: "real-host-1",
        version: "1.2.3",
        websocketUrl: "ws://example.com:51234/rpc",
      }),
      "utf8",
    );

    await expect(readRealMetadata(pidPath)).rejects.toThrow(
      /unexpected websocketUrl/,
    );
  });

  it("still rejects malformed pid.json missing required fields", async () => {
    const pidPath = join(dir, "pid.json");
    await writeFile(pidPath, JSON.stringify({ hostId: "real-host-1" }), "utf8");

    await expect(readRealMetadata(pidPath)).rejects.toThrow(/Malformed pid\.json/);
  });
});

describe("formatSessionSummary", () => {
  it("reports the recorded count, the dropped count and the output path", () => {
    expect(
      formatSessionSummary({
        stats: { recorded: 128, dropped: 3 },
        outPath: "recordings/boot.jsonl",
      }),
    ).toBe("capture-proxy stopped: 128 frame(s) recorded, 3 dropped -> recordings/boot.jsonl");
  });

  it("still names the output path when nothing was recorded", () => {
    expect(
      formatSessionSummary({
        stats: { recorded: 0, dropped: 0 },
        outPath: "recordings/empty.jsonl",
      }),
    ).toBe("capture-proxy stopped: 0 frame(s) recorded, 0 dropped -> recordings/empty.jsonl");
  });
});
