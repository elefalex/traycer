import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ENTRYPOINT = join(__dirname, "..", "main.ts");

type PidMetadata = {
  readonly pid: number;
  readonly hostId: string;
  readonly version: string;
  readonly websocketUrl: string;
  readonly startedAt: string;
  readonly processStartIdentity: null;
};

function isPidMetadata(value: unknown): value is PidMetadata {
  if (typeof value !== "object" || value === null) return false;
  if (!("websocketUrl" in value) || typeof value.websocketUrl !== "string") {
    return false;
  }
  return true;
}

async function waitForPidFile(
  pidPath: string,
  timeoutMs: number,
): Promise<PidMetadata> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw: unknown = JSON.parse(await readFile(pidPath, "utf8"));
      if (isPidMetadata(raw)) return raw;
    } catch {
      // Not written yet, or a half-written read raced the atomic rename —
      // either way, keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("main.ts never wrote a usable pid.json");
}

async function waitForPidFileGone(
  pidPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(pidPath, "utf8");
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("pid.json was not removed after SIGTERM");
}

describe("main.ts as a subprocess", () => {
  it("binds a live port, advertises it via pid.json, and cleans up on SIGTERM", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "open-host-main-"));
    const pidPath = join(dataDir, "pid.json");

    const child = Bun.spawn(["bun", ENTRYPOINT, "--host-data-dir", dataDir], {
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const meta = await waitForPidFile(pidPath, 10_000);

      const activityUrl = meta.websocketUrl
        .replace(/^ws:/, "http:")
        .replace(/\/rpc$/, "/activity");
      const response = await fetch(activityUrl);
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual({ busy: false });

      child.kill("SIGTERM");
      await child.exited;

      await waitForPidFileGone(pidPath, 5_000);
    } finally {
      child.kill("SIGKILL");
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});
