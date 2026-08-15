import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHostArgs } from "../bootstrap/args";
import { loadOrCreateIdentity } from "../bootstrap/identity";
import { removePidFile, writePidFile } from "../bootstrap/pid-file";

describe("parseHostArgs", () => {
  it("returns all-null for no args", () => {
    expect(parseHostArgs([])).toEqual({
      hostDataDir: null,
      layer0AttemptId: null,
      layer0StatusFd: null,
    });
  });

  it("parses the three CLI-supplied args the installer passes", () => {
    expect(
      parseHostArgs([
        "--host-data-dir",
        "/x",
        "--layer0-attempt-id",
        "abc",
        "--layer0-status-fd",
        "3",
      ]),
    ).toEqual({ hostDataDir: "/x", layer0AttemptId: "abc", layer0StatusFd: 3 });
  });

  it("tolerates unknown args instead of exiting", () => {
    expect(parseHostArgs(["--brand-new-flag", "v"]).hostDataDir).toBeNull();
  });
});

describe("identity", () => {
  it("creates a hostId and reuses it across restarts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "open-host-id-"));
    const first = await loadOrCreateIdentity({ dataDir });
    const second = await loadOrCreateIdentity({ dataDir });
    expect(first.hostId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.hostId).toBe(first.hostId);
  });
});

describe("pid file", () => {
  const meta = {
    pid: 1234,
    hostId: "h-1",
    version: "0.0.0",
    websocketUrl: "ws://127.0.0.1:5000/rpc",
    startedAt: "1970-01-01T00:00:00.000Z",
    processStartIdentity: null,
  } as const;

  it("writes every field the client decoder requires", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "open-host-pid-"));
    await writePidFile({ dataDir }, meta);
    const raw: unknown = JSON.parse(
      await readFile(join(dataDir, "pid.json"), "utf8"),
    );
    expect(raw).toEqual(meta);
  });

  it("removes the file on shutdown", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "open-host-pid-"));
    await writePidFile({ dataDir }, meta);
    await removePidFile({ dataDir });
    await expect(readFile(join(dataDir, "pid.json"), "utf8")).rejects.toThrow();
  });

  it("is a no-op when the file is already gone", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "open-host-pid-"));
    await expect(removePidFile({ dataDir })).resolves.toBeUndefined();
  });

  it("only advertises a loopback /rpc url", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "open-host-pid-"));
    await writePidFile({ dataDir }, meta);
    const text = await readFile(join(dataDir, "pid.json"), "utf8");
    expect(text).toContain("ws://127.0.0.1:");
    expect(text).toContain("/rpc");
  });
});
