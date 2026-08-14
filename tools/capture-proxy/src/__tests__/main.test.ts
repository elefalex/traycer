import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRealMetadata } from "../main";

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
