import type { ServerWebSocket } from "bun";
import { classifyFrame } from "./frame-classifier";
import type { Recorder } from "./recorder";

export type ProxyServer = { port: number; stop: () => Promise<void> };

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
  const record = (
    connId: string,
    leg: Leg,
    direction: "c2h" | "h2c",
    raw: string,
  ): void => {
    const { frame } = classifyFrame({
      raw,
      connId,
      leg,
      direction,
      ts: Date.now(),
    });
    // Fire-and-forget, but never unhandled: a rejected append (disk error,
    // or a write-after-close race with recorder.close()) must drop only
    // this one frame from the recording, never crash the proxy process.
    input.recorder.append(frame).catch((err: unknown) => {
      console.error(
        `[capture-proxy] failed to record frame connId=${connId} leg=${leg} direction=${direction} kind=${frame.kind}:`,
        err,
      );
    });
  };

  const server = Bun.serve<ConnState>({
    port: input.port,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/activity") return new Response("ok");
      if (url.pathname !== "/rpc" && url.pathname !== "/stream") {
        return new Response("not found", { status: 404 });
      }
      const leg: Leg = url.pathname === "/rpc" ? "rpc" : "stream";
      const connId = `conn-${(connCounter += 1)}`;
      const upstreamUrl = leg === "rpc" ? input.upstreamRpcUrl : input.upstreamStreamUrl;
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
        state.upstream.onclose = () => ws.close();
        state.upstream.onerror = () => ws.close();
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
        if (readyState === WebSocket.CLOSING || readyState === WebSocket.CLOSED) {
          // Upstream is gone or going away: sending would silently drop
          // the frame. Recording it as forwarded here would misrepresent
          // a dropped frame as delivered, so it is neither recorded nor
          // buffered.
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
    stop: async () => {
      server.stop(true);
    },
  };
}
