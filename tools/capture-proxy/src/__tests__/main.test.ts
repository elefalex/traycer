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

    await expect(readRealMetadata(pidPath)).rejects.toThrow(
      /Malformed pid\.json/,
    );
  });
});

describe("formatSessionSummary", () => {
  it("reports how many frames were written to the recording, and the output path", () => {
    expect(
      formatSessionSummary({
        stats: { recorded: 128, truncatedConnections: 0 },
        outPath: "recordings/boot.jsonl",
      }),
    ).toBe(
      "capture-proxy stopped: 128 frame(s) written to recordings/boot.jsonl",
    );
  });

  it("still names the output path when nothing was recorded", () => {
    expect(
      formatSessionSummary({
        stats: { recorded: 0, truncatedConnections: 0 },
        outPath: "recordings/empty.jsonl",
      }),
    ).toBe(
      "capture-proxy stopped: 0 frame(s) written to recordings/empty.jsonl",
    );
  });

  // The signal the operator actually needs: an upstream host socket that went
  // away while the app was still connected means the tail of that session was
  // never captured, and the recording is not a complete session.
  it("warns that the capture may be truncated when upstream was lost mid-session", () => {
    const summary = formatSessionSummary({
      stats: { recorded: 128, truncatedConnections: 2 },
      outPath: "recordings/boot.jsonl",
    });

    expect(summary).toContain(
      "capture-proxy stopped: 128 frame(s) written to recordings/boot.jsonl",
    );
    expect(summary).toMatch(/WARNING/);
    expect(summary).toMatch(/2 connection\(s\)/);
    expect(summary).toMatch(/truncated/);
  });

  it("says nothing about truncation when every connection outlived its upstream", () => {
    expect(
      formatSessionSummary({
        stats: { recorded: 12, truncatedConnections: 0 },
        outPath: "recordings/warm.jsonl",
      }),
    ).not.toMatch(/WARNING/);
  });
});
