import { parseHostArgs } from "./bootstrap/args";
import { loadOrCreateIdentity } from "./bootstrap/identity";
import { removePidFile, writePidFile } from "./bootstrap/pid-file";
import { handleOpenFrame } from "./handshake/rpc-handshake";
import { OPEN_HOST_VERSION } from "./index";
import { createDispatcher } from "./rpc/dispatcher";
import { methodTable } from "./rpc/method-table";
import { startListener } from "./server/listener";
import { resolveDataDir, type StorePaths } from "./store/store";

/**
 * Narrows `value` to "an object carrying `kind: 'open'`" without an `as`
 * cast, mirroring `isErrorWithCode` (`store/store.ts`) and `parseIdentity`
 * (`bootstrap/identity.ts`): the `in` check lets the compiler synthesize a
 * `{ kind: unknown }` shape before the literal comparison.
 */
function isOpenFrame(value: unknown): value is { readonly kind: "open" } {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  return value.kind === "open";
}

/**
 * Routes one `/rpc` text frame to whichever of the two frame families it is.
 *
 * The listener (`server/listener.ts`) hands every message on the `/rpc` leg
 * to a single `onRpcMessage` callback with no per-connection state, so this
 * function itself must distinguish the client's `open` frame (routed to
 * `handleOpenFrame`, Task 6) from every subsequent `request` frame (routed to
 * the dispatcher, this task) by peeking at the parsed `kind` field. A frame
 * that is neither — unparseable JSON, or some other structurally-shaped
 * value — falls through to `dispatch`, which applies the same drop-and-log
 * rule (never tear down the connection for one bad frame).
 */
function createRpcMessageHandler(
  dispatch: (raw: string) => Promise<string | null>,
): (send: (text: string) => void, raw: string) => void {
  return (send, raw) => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return;
    }
    if (isOpenFrame(parsedJson)) {
      const outcome = handleOpenFrame(parsedJson);
      send(JSON.stringify(outcome.frame));
      return;
    }
    void dispatch(raw).then((reply) => {
      if (reply !== null) send(reply);
    });
  };
}

/**
 * The `/stream` domain (host-initiated push frames such as worktree-changed
 * events) is out of scope for this task: Task 7 wires only the `/rpc` leg's
 * open+request routing. Frames on `/stream` are dropped without a reply.
 */
function onStreamMessage(): void {}

/**
 * Starts the open host daemon.
 *
 * Ordering is load-bearing: the listener binds its port FIRST, and only then
 * is `pid.json` written with that real port. `pid.json` is the desktop
 * client's only discovery channel for the host's `websocketUrl`
 * (`bootstrap/pid-file.ts`) — publishing it before the port is live would
 * advertise an endpoint that refuses connections.
 */
export async function main(): Promise<void> {
  const args = parseHostArgs(Bun.argv.slice(2));
  const paths: StorePaths = { dataDir: resolveDataDir(args.hostDataDir) };
  const identity = await loadOrCreateIdentity(paths);

  const dispatch = createDispatcher(methodTable);
  const listener = startListener({
    onRpcMessage: createRpcMessageHandler(dispatch),
    onStreamMessage,
  });

  await writePidFile(paths, {
    pid: process.pid,
    hostId: identity.hostId,
    version: OPEN_HOST_VERSION,
    websocketUrl: listener.websocketUrl,
    startedAt: new Date().toISOString(),
    processStartIdentity: null,
  });

  /**
   * Removing `pid.json` is the FIRST step, before `listener.stop()` is even
   * called, and `listener.stop()` throwing is caught rather than left to
   * propagate: a stale `pid.json` pointing at a dead port is the single
   * worst failure mode for the client (worse than no file at all), so
   * cleanup must complete and the process must still exit even if stopping
   * the listener itself goes wrong.
   */
  const shutdown = async (): Promise<void> => {
    await removePidFile(paths);
    try {
      await listener.stop();
    } catch (error) {
      console.error(
        "[open-host] listener.stop() failed during shutdown:",
        error,
      );
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

// Guarded so importing this module (e.g. from a test) does not also execute
// the daemon entrypoint — same guard as tools/capture-proxy/src/main.ts:212.
if (import.meta.main) {
  void main();
}
