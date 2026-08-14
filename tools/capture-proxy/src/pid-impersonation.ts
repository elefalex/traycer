import { readFile, rename, rm, writeFile } from "node:fs/promises";

export type ProxyPidMetadata = {
  readonly pid: number;
  readonly hostId: string;
  readonly version: string;
  readonly websocketUrl: string;
  readonly startedAt: string;
};

export function buildProxyPidMetadata(input: {
  realMetadata: { hostId: string; version: string };
  proxyPort: number;
  pid: number;
  nowIso: string;
}): ProxyPidMetadata {
  return {
    pid: input.pid,
    hostId: input.realMetadata.hostId,
    version: input.realMetadata.version,
    websocketUrl: `ws://127.0.0.1:${input.proxyPort}/rpc`,
    startedAt: input.nowIso,
  };
}

export async function swapPidFile(
  pidPath: string,
  next: ProxyPidMetadata,
): Promise<{ restore: () => Promise<void> }> {
  let original: string | null;
  try {
    original = await readFile(pidPath, "utf8");
  } catch {
    original = null;
  }
  const tmp = `${pidPath}.proxy-tmp`;
  await writeFile(tmp, JSON.stringify(next), "utf8");
  await rename(tmp, pidPath);
  return {
    restore: async () => {
      if (original === null) {
        await rm(pidPath, { force: true });
        return;
      }
      const restoreTmp = `${pidPath}.restore-tmp`;
      await writeFile(restoreTmp, original, "utf8");
      await rename(restoreTmp, pidPath);
    },
  };
}
