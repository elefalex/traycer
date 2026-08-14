import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Recorder } from "./recorder";
import {
  buildProxyPidMetadata,
  isValidLocalHostWebsocketUrl,
  swapPidFile,
} from "./pid-impersonation";
import {
  startProxyServer,
  type ProxyServer,
  type ProxyStats,
} from "./proxy-server";
import { createShutdownHandler } from "./shutdown";

type RealMetadata = {
  readonly hostId: string;
  readonly version: string;
  readonly rpcUrl: string;
  readonly streamUrl: string;
};

export async function readRealMetadata(pidFile: string): Promise<RealMetadata> {
  const parsed = JSON.parse(await readFile(pidFile, "utf8")) as Record<
    string,
    unknown
  >;
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
  if (!isValidLocalHostWebsocketUrl(websocketUrl)) {
    throw new Error(
      `pid.json at ${pidFile} has an unexpected websocketUrl (expected ws(s)://127.0.0.1:<port>/rpc): ${websocketUrl}`,
    );
  }
  return {
    hostId,
    version,
    rpcUrl: websocketUrl,
    streamUrl: websocketUrl.replace(/\/rpc$/, "/stream"),
  };
}

/**
 * What the operator sees on Ctrl-C. Without it an empty or half-empty
 * recording is only discoverable by opening the file.
 *
 * The count is deliberately worded as frames WRITTEN, not frames forwarded:
 * the proxy records a client frame before handing it to a socket that may
 * already be gone, so the recording's size is not evidence that the host
 * received any of it.
 *
 * The truncation warning is the one completeness claim that can be made
 * honestly, because losing an upstream socket under a live client leg is an
 * event the proxy observes directly.
 */
export function formatSessionSummary(input: {
  readonly stats: ProxyStats;
  readonly outPath: string;
}): string {
  const summary = `capture-proxy stopped: ${input.stats.recorded} frame(s) written to ${input.outPath}`;
  if (input.stats.truncatedConnections === 0) {
    return summary;
  }
  return (
    `${summary}\n` +
    `WARNING: ${input.stats.truncatedConnections} connection(s) lost the upstream host while the app was ` +
    `still connected - this capture is truncated and must not be trusted as a complete session. Restart ` +
    `the host and redo the run.`
  );
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
  readonly outPath: string;
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
      // Read the counters after the recorder is closed, so in-flight appends
      // have settled and the number reported is the number on disk. A failed
      // write here (e.g. a closed stdout) must not stop the process exiting.
      try {
        process.stdout.write(
          `${formatSessionSummary({ stats: deps.proxy.stats(), outPath: deps.outPath })}\n`,
        );
      } catch {
        // stdout is gone; the recording is already flushed either way.
      }
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
    console.error(
      "[capture-proxy] uncaught exception, restoring pid.json before exit:",
      error,
    );
    shutdownAndExit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(
      "[capture-proxy] unhandled rejection, restoring pid.json before exit:",
      reason,
    );
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
  // swapped). `proxy` and `restore` are tracked outside the try so the catch
  // below can undo them even when the failure happens after they were
  // acquired but before the process-level shutdown handlers are in place
  // (e.g. an EPIPE on the stdout write below, from an operator piping into
  // `| head`) — otherwise the real pid.json would be left pointing at a dead
  // proxy with no handler installed to restore it.
  let proxy: ProxyServer | null = null;
  let restore: (() => Promise<void>) | null = null;
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
    const swapped = await swapPidFile(pidFile, meta);
    restore = swapped.restore;

    process.stdout.write(
      `capture-proxy listening on ws://127.0.0.1:${proxy.port}/rpc\n` +
        `upstream ${real.rpcUrl}\nrecording -> ${out}\nCtrl-C to stop\n`,
    );

    installShutdownHandlers({ restore, proxy, recorder, outPath: out });
  } catch (error) {
    if (restore !== null) {
      await restore();
    }
    if (proxy !== null) {
      await proxy.stop();
    }
    await recorder.close();
    throw error;
  }

  await new Promise<void>(() => {});
}

// Guarded so importing this module (e.g. from a test, to exercise
// `readRealMetadata`) does not also execute the CLI entrypoint.
if (import.meta.main) {
  void run();
}
