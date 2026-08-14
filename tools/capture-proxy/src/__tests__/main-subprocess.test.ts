import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ENTRYPOINT = join(__dirname, "..", "main.ts");

async function waitForRewrite(
  pidPath: string,
  original: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await readFile(pidPath, "utf8");
    if (current !== original) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("proxy never rewrote pid.json");
}

describe("main.ts as a subprocess", () => {
  it("restores pid.json when terminated by a signal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capture-proxy-main-"));
    const pidPath = join(dir, "pid.json");
    const original = JSON.stringify({
      pid: 4242,
      hostId: "test-host",
      version: "0.0.0-test",
      websocketUrl: "ws://127.0.0.1:59999/rpc",
      startedAt: new Date(0).toISOString(),
      processStartIdentity: null,
    });
    await writeFile(pidPath, original, "utf8");

    const child = Bun.spawn(
      ["bun", ENTRYPOINT, "--pid-file", pidPath, "--out", join(dir, "o.jsonl")],
      { stdout: "pipe", stderr: "pipe" },
    );

    await waitForRewrite(pidPath, original, 5_000);
    child.kill("SIGTERM");
    await child.exited;

    expect(await readFile(pidPath, "utf8")).toBe(original);
  }, 20_000);
});
