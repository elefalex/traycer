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
  const proxyBytes = JSON.stringify(next);
  const tmp = `${pidPath}.proxy-tmp`;
  await writeFile(tmp, proxyBytes, "utf8");
  await rename(tmp, pidPath);
  let restored = false;
  return {
    restore: async () => {
      // Idempotent: the shutdown routine is wired to several exit paths, and
      // a second call must not re-run the checks below (which would read the
      // already-restored file and misreport it as a foreign rewrite).
      if (restored) {
        return;
      }
      // The dev host can restart mid-capture (crash, update, HMR) and write a
      // fresh pid.json pointing at its new port. Blindly restoring the
      // pre-capture bytes over that would break the operator's real install
      // until they noticed and restarted it. Only restore when pid.json still
      // holds exactly what this process wrote at swap time.
      let current: string | null;
      try {
        current = await readFile(pidPath, "utf8");
      } catch (error) {
        const code = readErrorCode(error);
        if (code === "ENOENT") {
          current = null;
        } else {
          throw error;
        }
      }
      if (current === null) {
        // Nobody rewrote it: pid.json is simply gone, because the host shut
        // down and cleaned up after itself. Same outcome as a foreign
        // rewrite (the pre-capture bytes are not resurrected — writing them
        // back would advertise a host that is no longer running), but saying
        // "rewritten by another process" here sends the operator hunting for
        // a process that never touched it.
        console.error(
          `[capture-proxy] pid.json at ${pidPath} no longer exists ` +
            `(the host likely shut down mid-capture) - leaving it absent rather than ` +
            `recreating it from stale pre-capture metadata`,
        );
        restored = true;
        return;
      }
      if (current !== proxyBytes) {
        console.error(
          `[capture-proxy] pid.json at ${pidPath} was rewritten by another process ` +
            `(the host likely restarted mid-capture) - leaving it alone rather than ` +
            `overwriting it with stale pre-capture metadata`,
        );
        restored = true;
        return;
      }
      if (original === null) {
        await rm(pidPath, { force: true });
        restored = true;
        return;
      }
      const restoreTmp = `${pidPath}.restore-tmp`;
      await writeFile(restoreTmp, original, "utf8");
      await rename(restoreTmp, pidPath);
      restored = true;
    },
  };
}
