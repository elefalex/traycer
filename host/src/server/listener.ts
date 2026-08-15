import type { ServerWebSocket } from "bun";

/**
 * `GET /activity` contract: the desktop's restart-safety probe
 * (clients/shared/host-client/host-activity-probe.ts:26-45) does
 * `fetch(toActivityUrl(websocketUrl))` and treats `!response.ok` as busy
 * (host-activity-probe.ts:30-32). It then parses the body as JSON and
 * requires an object with a `busy` property whose `typeof` is `"boolean"`
 * (host-activity-probe.ts:33-42); anything else — a non-2xx status, a
 * malformed body, a missing/mistyped field, a connect error, or the probe's
 * own 1500ms timeout (host-activity-probe.ts:14,28) — fails safe as BUSY,
 * which blocks the desktop from tearing this host down. This handler must
 * therefore answer HTTP 200 with a JSON body of exactly `{"busy": false}`.
 *
 * The URL mapping `ws://127.0.0.1:<port>/rpc` -> `http://127.0.0.1:<port>/activity`
 * (host-activity-probe.ts:72-77) is plain loopback HTTP, not TLS, which is
 * why this listener serves `/activity` on the same `Bun.serve` instance as
 * the WebSocket legs below rather than a separate secure port.
 */
function activityResponse(): Response {
  return Response.json({ busy: false });
}

export type LegHandlers = {
  readonly onRpcMessage: (send: (text: string) => void, raw: string) => void;
  readonly onStreamMessage: (send: (text: string) => void, raw: string) => void;
};

export type Listener = {
  readonly port: number;
  readonly websocketUrl: string;
  stop(): Promise<void>;
};

type Leg = "rpc" | "stream";

/**
 * Stored on `ServerWebSocket.data` at upgrade time (set from the URL path in
 * `fetch`, see below) so `message` can route a frame to the right handler
 * without re-parsing the request URL — a socket only ever carries the leg it
 * upgraded on.
 */
type SocketData = {
  readonly leg: Leg;
};

/**
 * Starts the host's loopback network surface: `GET /activity` (a plain HTTP
 * probe, see `activityResponse` above) plus two WebSocket legs, `/rpc` and
 * `/stream`, sharing one `Bun.serve` instance and port.
 *
 * Binds `127.0.0.1` explicitly (never `0.0.0.0` or Bun's default) and port
 * `0` (kernel-assigned): the desktop client rejects any advertised
 * `websocketUrl` that is not loopback, this RPC surface is unauthenticated
 * by design (the handshake's bearer token is accepted and ignored), and a
 * hardcoded port would both collide with the proprietary host and prevent
 * tests from running concurrently.
 *
 * `/rpc` and `/stream` are different wire contracts that happen to share a
 * port: routing is decided once, by path, at upgrade time, and the decision
 * is carried on the socket's `data` rather than re-derived per message so a
 * frame from one leg can never reach the other leg's handler.
 */
export function startListener(handlers: LegHandlers): Listener {
  const server = Bun.serve<SocketData, never>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname === "/activity") {
        return activityResponse();
      }
      if (url.pathname === "/rpc" || url.pathname === "/stream") {
        const leg: Leg = url.pathname === "/rpc" ? "rpc" : "stream";
        if (srv.upgrade(request, { data: { leg } })) return undefined;
        return new Response("upgrade failed", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(ws: ServerWebSocket<SocketData>, message) {
        const raw =
          typeof message === "string" ? message : message.toString("utf8");
        const send = (text: string): void => {
          ws.send(text);
        };
        if (ws.data.leg === "rpc") {
          handlers.onRpcMessage(send, raw);
        } else {
          handlers.onStreamMessage(send, raw);
        }
      },
    },
  });

  const port = server.port;
  if (port === undefined) {
    throw new Error("open host listener started without a network port");
  }

  return {
    port,
    websocketUrl: `ws://127.0.0.1:${port}/rpc`,
    stop: async () => {
      server.stop(true);
    },
  };
}
