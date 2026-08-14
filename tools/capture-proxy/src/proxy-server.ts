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
  upstreamOpen: boolean;
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
    void input.recorder.append(frame);
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
      const state: ConnState = { connId, leg, upstream, outbox: [], upstreamOpen: false };
      if (srv.upgrade(req, { data: state })) return undefined;
      return new Response("upgrade failed", { status: 500 });
    },
    websocket: {
      open(ws: ServerWebSocket<ConnState>) {
        const state = ws.data;
        state.upstream.onopen = () => {
          state.upstreamOpen = true;
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
        record(state.connId, state.leg, "c2h", raw);
        if (state.upstreamOpen) state.upstream.send(raw);
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
