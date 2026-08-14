import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Recorder } from "../recorder";
import { startProxyServer, type ProxyServer } from "../proxy-server";

let dir: string;
let upstream: Server<undefined> | null = null;
let proxy: ProxyServer | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cap-proxy-"));
});
afterEach(async () => {
  await proxy?.stop();
  upstream?.stop(true);
  await rm(dir, { recursive: true, force: true });
});

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > 4000) return reject(new Error("timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("startProxyServer", () => {
  it("forwards /rpc frames both ways and records them", async () => {
    // Fake upstream host: echoes an openAck then a response.
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("no");
      },
      websocket: {
        message(ws, msg) {
          const frame = JSON.parse(String(msg));
          if (frame.kind === "open") ws.send(JSON.stringify({ kind: "openAck", manifest: {} }));
          if (frame.kind === "request")
            ws.send(
              JSON.stringify({
                kind: "response",
                requestId: frame.requestId,
                method: frame.method,
                schemaVersion: frame.schemaVersion,
                result: { ok: true },
                error: null,
              }),
            );
        },
      },
    });
    const upstreamUrl = `ws://127.0.0.1:${upstream.port}/rpc`;
    const recFile = join(dir, "rec.jsonl");
    const recorder = new Recorder(recFile);
    proxy = await startProxyServer({
      upstreamRpcUrl: upstreamUrl,
      upstreamStreamUrl: upstreamUrl.replace("/rpc", "/stream"),
      recorder,
      port: 0,
    });

    const received: unknown[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/rpc`);
    client.onopen = () => {
      client.send(JSON.stringify({ kind: "open", token: "t", manifest: {} }));
      client.send(
        JSON.stringify({
          kind: "request",
          requestId: "r1",
          method: "host.status",
          schemaVersion: { major: 1, minor: 0 },
          params: {},
        }),
      );
    };
    client.onmessage = (ev) => received.push(JSON.parse(String(ev.data)));

    await waitFor(() => received.some((f) => (f as { kind: string }).kind === "response"));
    client.close();
    await recorder.close();

    const activity = await fetch(`http://127.0.0.1:${proxy.port}/activity`);
    expect(activity.status).toBe(200);

    const lines = (await readFile(recFile, "utf8")).trim().split("\n");
    const kinds = lines.map((l) => JSON.parse(l).kind);
    expect(kinds).toContain("open");
    expect(kinds).toContain("openAck");
    expect(kinds).toContain("response");
  });

  it("returns 200 ok for GET /activity", async () => {
    proxy = await startProxyServer({
      upstreamRpcUrl: "ws://127.0.0.1:1/rpc",
      upstreamStreamUrl: "ws://127.0.0.1:1/stream",
      recorder: new Recorder(join(dir, "unused.jsonl")),
      port: 0,
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/activity`);
    expect(res.status).toBe(200);
  });

  it("returns 404 for an unknown path and does not crash the server", async () => {
    proxy = await startProxyServer({
      upstreamRpcUrl: "ws://127.0.0.1:1/rpc",
      upstreamStreamUrl: "ws://127.0.0.1:1/stream",
      recorder: new Recorder(join(dir, "unused.jsonl")),
      port: 0,
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/nope`);
    expect(res.status).toBe(404);

    // Server must still be alive after the 404.
    const activity = await fetch(`http://127.0.0.1:${proxy.port}/activity`);
    expect(activity.status).toBe(200);
  });

  it("buffers client frames sent before upstream connects and flushes them in order", async () => {
    const upstreamReceived: string[] = [];
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("no");
      },
      websocket: {
        message(_ws, msg) {
          upstreamReceived.push(String(msg));
        },
      },
    });
    const upstreamUrl = `ws://127.0.0.1:${upstream.port}/rpc`;
    const recorder = new Recorder(join(dir, "order.jsonl"));
    proxy = await startProxyServer({
      upstreamRpcUrl: upstreamUrl,
      upstreamStreamUrl: upstreamUrl.replace("/rpc", "/stream"),
      recorder,
      port: 0,
    });

    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/rpc`);
    client.onopen = () => {
      // Fired the instant the client<->proxy socket is open, almost
      // certainly before the proxy's upstream socket has finished
      // connecting. These must be buffered and flushed in order.
      client.send("first");
      client.send("second");
      client.send("third");
    };

    await waitFor(() => upstreamReceived.length >= 3);
    client.close();
    await recorder.close();

    expect(upstreamReceived).toEqual(["first", "second", "third"]);
  });

  it("records the /stream leg as 'stream', not hardcoded to 'rpc'", async () => {
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("no");
      },
      websocket: {
        message(ws) {
          ws.send(JSON.stringify({ kind: "ack" }));
        },
      },
    });
    const upstreamUrl = `ws://127.0.0.1:${upstream.port}/rpc`;
    const recFile = join(dir, "stream.jsonl");
    const recorder = new Recorder(recFile);
    proxy = await startProxyServer({
      upstreamRpcUrl: upstreamUrl,
      upstreamStreamUrl: upstreamUrl.replace("/rpc", "/stream"),
      recorder,
      port: 0,
    });

    const received: unknown[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/stream`);
    client.onopen = () => client.send(JSON.stringify({ kind: "subscribe" }));
    client.onmessage = (ev) => received.push(JSON.parse(String(ev.data)));

    await waitFor(() => received.length >= 1);
    client.close();
    await recorder.close();

    const lines = (await readFile(recFile, "utf8")).trim().split("\n");
    const legs = lines.map((l) => JSON.parse(l).leg);
    expect(legs.length).toBeGreaterThan(0);
    expect(legs.every((leg) => leg === "stream")).toBe(true);
  });

  it("records both directions (c2h and h2c) under the same connId", async () => {
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("no");
      },
      websocket: {
        message(ws) {
          ws.send(JSON.stringify({ kind: "ack" }));
        },
      },
    });
    const upstreamUrl = `ws://127.0.0.1:${upstream.port}/rpc`;
    const recFile = join(dir, "directions.jsonl");
    const recorder = new Recorder(recFile);
    proxy = await startProxyServer({
      upstreamRpcUrl: upstreamUrl,
      upstreamStreamUrl: upstreamUrl.replace("/rpc", "/stream"),
      recorder,
      port: 0,
    });

    const received: unknown[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/rpc`);
    client.onopen = () => client.send(JSON.stringify({ kind: "ping" }));
    client.onmessage = (ev) => received.push(JSON.parse(String(ev.data)));

    await waitFor(() => received.length >= 1);
    client.close();
    await recorder.close();

    const frames = (await readFile(recFile, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const c2h = frames.find((f) => f.direction === "c2h");
    const h2c = frames.find((f) => f.direction === "h2c");
    expect(c2h).toBeDefined();
    expect(h2c).toBeDefined();
    expect(c2h.connId).toBe(h2c.connId);
  });
});
