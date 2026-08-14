import type { ServerWebSocket } from "bun";
import { classifyFrame } from "./frame-classifier";
import type { Recorder } from "./recorder";

/**
 * Counters behind the end-of-session summary.
 *
 * `recorded` counts frames that actually reached the recording file (an
 * append that rejected is not one). It says nothing about delivery: a frame
 * handed to `.send()` on a socket that has already gone away upstream is
 * recorded but silently not delivered, and this proxy cannot tell the
 * difference without redesigning the send path.
 *
 * `truncatedConnections` counts connections whose upstream host socket closed
 * while the client leg was still open. Each one means the tail of that
 * session was never seen, so the recording is not a complete session.
 */
export type ProxyStats = {
  readonly recorded: number;
  readonly truncatedConnections: number;
};

export type ProxyServer = {
  port: number;
  stats: () => ProxyStats;
  stop: () => Promise<void>;
};

type Leg = "rpc" | "stream";
type ConnState = {
  connId: string;
  leg: Leg;
  upstream: WebSocket;
  outbox: string[];
};

let connCounter = 0;

export async function startProxyServer(input: {
  upstreamRpcUrl: string;
  upstreamStreamUrl: string;
  recorder: Recorder;
  port: number;
}): Promise<ProxyServer> {
  let recordedCount = 0;
  let truncatedConnections = 0;
  const record = (
    connId: string,
    leg: Leg,
    direction: "c2h" | "h2c",
    raw: string,
  ): void => {
    const { frame, valid } = classifyFrame({
      raw,
      connId,
      leg,
      direction,
      ts: Date.now(),
    });
    if (!valid) {
      // The whole reason this tool exists: the open repo's schemas are the
      // claim, the closed host's traffic is the evidence. A frame the
      // schema rejects is a finding, so say so at capture time instead of
      // leaving it to be noticed (or not) in the recording later. It is
      // deliberately not recorded as a field on RecordedFrame — that shape
      // is closed and consumers depend on it.
      console.error(
        `[capture-proxy] frame rejected by ${direction === "c2h" ? "clientFrameSchema" : "hostFrameSchema"} ` +
          `connId=${connId} leg=${leg} direction=${direction} kind=${frame.kind} method=${frame.method ?? "-"}`,
      );
    }
    // Fire-and-forget, but never unhandled: a rejected append (disk error,
    // or a write-after-close race with recorder.close()) must drop only
    // this one frame from the recording, never crash the proxy process.
    input.recorder.append(frame).then(
      () => {
        recordedCount += 1;
      },
      (err: unknown) => {
        console.error(
          `[capture-proxy] failed to record frame connId=${connId} leg=${leg} direction=${direction} kind=${frame.kind}:`,
          err,
        );
      },
    );
  };

  const server = Bun.serve<ConnState>({
    port: input.port,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/activity") {
        // The client probe (clients/shared/host-client/host-activity-probe.ts)
        // parses this body as JSON and reads a boolean `busy`; anything else
        // fail-safes to busy. Answer busy for real: a host being captured is
        // in use, and nothing should conclude it is idle and tear it down
        // mid-recording.
        return Response.json({ busy: true });
      }
      if (url.pathname !== "/rpc" && url.pathname !== "/stream") {
        return new Response("not found", { status: 404 });
      }
      const leg: Leg = url.pathname === "/rpc" ? "rpc" : "stream";
      const connId = `conn-${(connCounter += 1)}`;
      const upstreamUrl =
        leg === "rpc" ? input.upstreamRpcUrl : input.upstreamStreamUrl;
      const upstream = new WebSocket(upstreamUrl);
      const state: ConnState = { connId, leg, upstream, outbox: [] };
      if (srv.upgrade(req, { data: state })) return undefined;
      // Upgrade failed (e.g. no Upgrade header): the outbound dial to the
      // real host daemon was already started above and must not leak.
      upstream.close();
      return new Response("upgrade failed", { status: 500 });
    },
    websocket: {
      open(ws: ServerWebSocket<ConnState>) {
        const state = ws.data;
        state.upstream.onopen = () => {
          for (const msg of state.outbox) state.upstream.send(msg);
          state.outbox = [];
        };
        state.upstream.onmessage = (ev) => {
          const raw = String(ev.data);
          record(state.connId, state.leg, "h2c", raw);
          ws.send(raw);
        };
        // An upstream failure fires onerror and then onclose; this connection
        // is one truncated capture either way, not two.
        let countedTruncation = false;
        const onUpstreamGone = (): void => {
          // Upstream closing while the client leg is still open means the
          // host went away under a live app (crash, update, restart): from
          // here on nothing more of that session can be captured, so the
          // recording holds only its beginning. The ordinary teardown is the
          // other order — the app disconnects, then `close()` below tears
          // the upstream socket down — and by then this socket is no longer
          // OPEN, so it is not counted.
          if (!countedTruncation && ws.readyState === WebSocket.OPEN) {
            countedTruncation = true;
            truncatedConnections += 1;
            console.error(
              `[capture-proxy] upstream closed while the client was still connected ` +
                `connId=${state.connId} leg=${state.leg}: the capture of this connection is truncated`,
            );
          }
          ws.close();
        };
        state.upstream.onclose = onUpstreamGone;
        state.upstream.onerror = onUpstreamGone;
      },
      message(ws: ServerWebSocket<ConnState>, msg) {
        const state = ws.data;
        const raw = String(msg);
        // Read the upstream socket's live readyState rather than a cached
        // boolean: a flag toggled from an onopen/onclose/onerror callback
        // can lag the socket's actual state by one event-loop turn (e.g.
        // upstream has already started closing but its onclose callback
        // hasn't run yet), during which `.send()` on it silently no-ops.
        // readyState is authoritative at the instant we check it, so it
        // cannot go stale the way a cached flag can.
        const readyState = state.upstream.readyState;
        if (
          readyState === WebSocket.CLOSING ||
          readyState === WebSocket.CLOSED
        ) {
          // Upstream is gone or going away: sending would silently drop
          // the frame. Recording it as forwarded here would misrepresent
          // a dropped frame as delivered, so it is neither recorded nor
          // buffered. Logged per occurrence rather than counted for the
          // summary: this branch sees only the drops it can prove, while a
          // frame sent into a socket whose close it has not yet observed is
          // dropped just as silently and never reaches here, so a total
          // printed at shutdown would read as an all-clear it cannot back.
          console.error(
            `[capture-proxy] dropping c2h frame for connId=${state.connId} leg=${state.leg}: upstream readyState=${readyState}`,
          );
          return;
        }
        record(state.connId, state.leg, "c2h", raw);
        if (readyState === WebSocket.OPEN) state.upstream.send(raw);
        else state.outbox.push(raw);
      },
      close(ws: ServerWebSocket<ConnState>) {
        try {
          ws.data.upstream.close();
        } catch {
          // upstream already closed
        }
      },
    },
  });

  const port = server.port;
  if (port === undefined) {
    throw new Error("proxy server started without a network port");
  }

  return {
    port,
    stats: () => ({ recorded: recordedCount, truncatedConnections }),
    stop: async () => {
      server.stop(true);
    },
  };
}
