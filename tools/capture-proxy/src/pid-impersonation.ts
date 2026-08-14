import { readFile, rename, rm, writeFile } from "node:fs/promises";

function readErrorCode(error: unknown): string | null {
  if (error === null || error === undefined) {
    return null;
  }
  if (typeof error === "object") {
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code : null;
  }
  return null;
}

export function isValidLocalHostWebsocketUrl(websocketUrl: string): boolean {
  try {
    const url = new URL(websocketUrl);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      return false;
    }
    if (url.hostname !== "127.0.0.1") {
      return false;
    }
    if (url.pathname !== "/rpc") {
      return false;
    }
    if (url.search !== "") {
      return false;
    }
    if (url.hash !== "") {
      return false;
    }
    if (url.username !== "") {
      return false;
    }
    if (url.password !== "") {
      return false;
    }
    const portNum = Number(url.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

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
  const websocketUrl = `ws://127.0.0.1:${input.proxyPort}/rpc`;
  if (!isValidLocalHostWebsocketUrl(websocketUrl)) {
    throw new Error(`invalid proxy websocketUrl: ${websocketUrl}`);
  }
  return {
    pid: input.pid,
    hostId: input.realMetadata.hostId,
    version: input.realMetadata.version,
    websocketUrl,
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
  } catch (error) {
    const code = readErrorCode(error);
    if (code === "ENOENT") {
      original = null;
    } else {
      throw error;
    }
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
