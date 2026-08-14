import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProxyPidMetadata, swapPidFile } from "../pid-impersonation";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cap-pid-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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
});
