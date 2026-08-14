import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Recorder } from "./recorder";
import { buildProxyPidMetadata, swapPidFile } from "./pid-impersonation";
import { startProxyServer, type ProxyServer } from "./proxy-server";
import { createShutdownHandler } from "./shutdown";

type RealMetadata = {
  readonly hostId: string;
  readonly version: string;
  readonly rpcUrl: string;
  readonly streamUrl: string;
};

async function readRealMetadata(pidFile: string): Promise<RealMetadata> {
  const parsed = JSON.parse(await readFile(pidFile, "utf8")) as Record<string, unknown>;
  const websocketUrl = parsed.websocketUrl;
  const hostId = parsed.hostId;
  const version = parsed.version;
  if (
    typeof websocketUrl !== "string" ||
    typeof hostId !== "string" ||
    typeof version !== "string"
  ) {
    throw new Error(`Malformed pid.json at ${pidFile}`);
  }
  return {
    hostId,
    version,
    rpcUrl: websocketUrl,
    streamUrl: websocketUrl.replace(/\/rpc$/, "/stream"),
  };
}

/**
 * Wires the shared shutdown routine to every exit path that can occur once
 * pid.json has been swapped to point at the proxy:
 *  - SIGINT / SIGTERM (operator stops the proxy)
 *  - uncaughtException / unhandledRejection (the process crashes)
 *
 * A crash must not strand pid.json pointing at a dead proxy, so every path
 * restores it before the process exits. `createShutdownHandler` makes the
 * restore/stop/close sequence idempotent, so it is safe to wire it to
 * multiple listeners here (e.g. an impatient double Ctrl-C, or a signal
 * racing a crash) without risk of double-running or throwing.
 */
function installShutdownHandlers(deps: {
  readonly restore: () => Promise<void>;
  readonly proxy: ProxyServer;
  readonly recorder: Recorder;
}): void {
  const shutdown = createShutdownHandler({
    restore: deps.restore,
    stop: deps.proxy.stop,
    close: () => deps.recorder.close(),
    onStepError: (step, error) => {
      console.error(`[capture-proxy] shutdown step "${step}" failed:`, error);
    },
  });

  const shutdownAndExit = (code: number): void => {
    void shutdown().then(() => {
      process.exit(code);
    });
  };

  process.on("SIGINT", () => {
    shutdownAndExit(0);
  });
  process.on("SIGTERM", () => {
    shutdownAndExit(0);
  });
  process.on("uncaughtException", (error) => {
    console.error("[capture-proxy] uncaught exception, restoring pid.json before exit:", error);
    shutdownAndExit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[capture-proxy] unhandled rejection, restoring pid.json before exit:", reason);
    shutdownAndExit(1);
  });
}

async function run(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "pid-file": { type: "string" },
      out: { type: "string" },
    },
  });
  const pidFile = values["pid-file"];
  const out = values.out;
  if (typeof pidFile !== "string" || typeof out !== "string") {
    throw new Error("Usage: main.ts --pid-file <path> --out <recording.jsonl>");
  }

  const real = await readRealMetadata(pidFile);
  const recorder = new Recorder(out);

  // Everything from here on acquires a resource that must be torn down if a
  // later step fails: the proxy server (once started) and pid.json (once
  // swapped). `proxy` is tracked outside the try so the catch below can stop
  // it even when the failure happens after it started but before the swap
  // (or the process-level shutdown handlers) are in place.
  let proxy: ProxyServer | null = null;
  try {
    proxy = await startProxyServer({
      upstreamRpcUrl: real.rpcUrl,
      upstreamStreamUrl: real.streamUrl,
      recorder,
      port: 0,
    });
    const meta = buildProxyPidMetadata({
      realMetadata: { hostId: real.hostId, version: real.version },
      proxyPort: proxy.port,
      pid: process.pid,
      nowIso: new Date().toISOString(),
    });
    const { restore } = await swapPidFile(pidFile, meta);

    process.stdout.write(
      `capture-proxy listening on ws://127.0.0.1:${proxy.port}/rpc\n` +
        `upstream ${real.rpcUrl}\nrecording -> ${out}\nCtrl-C to stop\n`,
    );

    installShutdownHandlers({ restore, proxy, recorder });
  } catch (error) {
    if (proxy !== null) {
      await proxy.stop();
    }
    await recorder.close();
    throw error;
  }

  await new Promise<void>(() => {});
}

void run();
