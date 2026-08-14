import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildProxyPidMetadata,
  isValidLocalHostWebsocketUrl,
  swapPidFile,
} from "../pid-impersonation";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cap-pid-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isValidLocalHostWebsocketUrl", () => {
  it("accepts ws and wss with 127.0.0.1:<port>/rpc", () => {
    expect(isValidLocalHostWebsocketUrl("ws://127.0.0.1:51234/rpc")).toBe(true);
    expect(isValidLocalHostWebsocketUrl("wss://127.0.0.1:51234/rpc")).toBe(
      true,
    );
    expect(isValidLocalHostWebsocketUrl("ws://127.0.0.1:1/rpc")).toBe(true);
    expect(isValidLocalHostWebsocketUrl("ws://127.0.0.1:65535/rpc")).toBe(true);
  });

  it("rejects non-127.0.0.1 hosts", () => {
    expect(isValidLocalHostWebsocketUrl("ws://localhost:51234/rpc")).toBe(
      false,
    );
    expect(isValidLocalHostWebsocketUrl("ws://127.0.0.2:51234/rpc")).toBe(
      false,
    );
  });

  it("rejects non-/rpc paths", () => {
    expect(isValidLocalHostWebsocketUrl("ws://127.0.0.1:51234/other")).toBe(
      false,
    );
  });

  it("rejects search and hash", () => {
    expect(isValidLocalHostWebsocketUrl("ws://127.0.0.1:51234/rpc?a=b")).toBe(
      false,
    );
    expect(isValidLocalHostWebsocketUrl("ws://127.0.0.1:51234/rpc#frag")).toBe(
      false,
    );
  });

  it("rejects out-of-range ports", () => {
    expect(isValidLocalHostWebsocketUrl("ws://127.0.0.1:0/rpc")).toBe(false);
    expect(isValidLocalHostWebsocketUrl("ws://127.0.0.1:70000/rpc")).toBe(
      false,
    );
  });
});

describe("buildProxyPidMetadata", () => {
  it("emits a loopback /rpc url with no processStartIdentity", () => {
    const meta = buildProxyPidMetadata({
      realMetadata: { hostId: "h1", version: "9.9.9" },
      proxyPort: 51234,
      pid: 4242,
      nowIso: "2026-08-14T00:00:00.000Z",
    });
    expect(meta.websocketUrl).toBe("ws://127.0.0.1:51234/rpc");
    expect(meta.pid).toBe(4242);
    expect("processStartIdentity" in meta).toBe(false);
  });

  it("throws on out-of-range port 0", () => {
    expect(() =>
      buildProxyPidMetadata({
        realMetadata: { hostId: "h1", version: "9.9.9" },
        proxyPort: 0,
        pid: 4242,
        nowIso: "2026-08-14T00:00:00.000Z",
      }),
    ).toThrow(/invalid proxy websocketUrl/);
  });

  it("throws on out-of-range port 70000", () => {
    expect(() =>
      buildProxyPidMetadata({
        realMetadata: { hostId: "h1", version: "9.9.9" },
        proxyPort: 70000,
        pid: 4242,
        nowIso: "2026-08-14T00:00:00.000Z",
      }),
    ).toThrow(/invalid proxy websocketUrl/);
  });
});

describe("swapPidFile", () => {
  it("restores the original bytes on restore()", async () => {
    const pidPath = join(dir, "pid.json");
    await writeFile(pidPath, '{"original":true}', "utf8");
    const next = buildProxyPidMetadata({
      realMetadata: { hostId: "h1", version: "9.9.9" },
      proxyPort: 51234,
      pid: 4242,
      nowIso: "2026-08-14T00:00:00.000Z",
    });
    const { restore } = await swapPidFile(pidPath, next);
    expect(JSON.parse(await readFile(pidPath, "utf8")).pid).toBe(4242);
    await restore();
    expect(await readFile(pidPath, "utf8")).toBe('{"original":true}');
  });

  it("unlinks file on restore() when no original existed", async () => {
    const pidPath = join(dir, "pid.json");
    const next = buildProxyPidMetadata({
      realMetadata: { hostId: "h1", version: "9.9.9" },
      proxyPort: 51234,
      pid: 4242,
      nowIso: "2026-08-14T00:00:00.000Z",
    });
    const { restore } = await swapPidFile(pidPath, next);
    expect(existsSync(pidPath)).toBe(true);
    expect(JSON.parse(await readFile(pidPath, "utf8")).pid).toBe(4242);
    await restore();
    expect(existsSync(pidPath)).toBe(false);
  });

  it("double-restore does not throw with original present", async () => {
    const pidPath = join(dir, "pid.json");
    await writeFile(pidPath, '{"original":true}', "utf8");
    const next = buildProxyPidMetadata({
      realMetadata: { hostId: "h1", version: "9.9.9" },
      proxyPort: 51234,
      pid: 4242,
      nowIso: "2026-08-14T00:00:00.000Z",
    });
    const { restore } = await swapPidFile(pidPath, next);
    await restore();
    await restore();
    expect(await readFile(pidPath, "utf8")).toBe('{"original":true}');
  });

  it("double-restore does not throw with no original", async () => {
    const pidPath = join(dir, "pid.json");
    const next = buildProxyPidMetadata({
      realMetadata: { hostId: "h1", version: "9.9.9" },
      proxyPort: 51234,
      pid: 4242,
      nowIso: "2026-08-14T00:00:00.000Z",
    });
    const { restore } = await swapPidFile(pidPath, next);
    await restore();
    await restore();
    expect(existsSync(pidPath)).toBe(false);
  });

  // The dev host restarting mid-capture (crash, update, HMR) rewrites
  // pid.json with a fresh, valid port. Restoring stale pre-capture bytes
  // over that actively breaks the operator's real install.
  it("leaves a pid.json rewritten by another process alone instead of clobbering it", async () => {
    const pidPath = join(dir, "pid.json");
    await writeFile(pidPath, '{"original":true}', "utf8");
    const next = buildProxyPidMetadata({
      realMetadata: { hostId: "h1", version: "9.9.9" },
      proxyPort: 51234,
      pid: 4242,
      nowIso: "2026-08-14T00:00:00.000Z",
    });
    const { restore } = await swapPidFile(pidPath, next);

    // The real host respawns and publishes itself on a new port.
    const rewritten = '{"pid":777,"websocketUrl":"ws://127.0.0.1:60000/rpc"}';
    await writeFile(pidPath, rewritten, "utf8");

    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map((arg) => String(arg)).join(" "));
      });
    try {
      await restore();
    } finally {
      spy.mockRestore();
    }

    expect(await readFile(pidPath, "utf8")).toBe(rewritten);
    expect(errors.join("\n")).toMatch(/rewritten by another process/);
  });

  it("does not delete a pid.json another process wrote when there was no original", async () => {
    const pidPath = join(dir, "pid.json");
    const next = buildProxyPidMetadata({
      realMetadata: { hostId: "h1", version: "9.9.9" },
      proxyPort: 51234,
      pid: 4242,
      nowIso: "2026-08-14T00:00:00.000Z",
    });
    const { restore } = await swapPidFile(pidPath, next);

    const rewritten = '{"pid":777,"websocketUrl":"ws://127.0.0.1:60000/rpc"}';
    await writeFile(pidPath, rewritten, "utf8");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await restore();
    } finally {
      spy.mockRestore();
    }

    expect(existsSync(pidPath)).toBe(true);
    expect(await readFile(pidPath, "utf8")).toBe(rewritten);
  });
});
