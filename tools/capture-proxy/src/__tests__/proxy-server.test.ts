import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
          if (frame.kind === "open")
            ws.send(JSON.stringify({ kind: "openAck", manifest: {} }));
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

    await waitFor(() =>
      received.some((f) => (f as { kind: string }).kind === "response"),
    );
    client.close();
    await recorder.close();

    const activity = await fetch(`http://127.0.0.1:${proxy.port}/activity`);
    expect(activity.status).toBe(200);

    const lines = (await readFile(recFile, "utf8")).trim().split("\n");
    const kinds = lines.map((l) => JSON.parse(l).kind);
    expect(kinds).toContain("open");
    expect(kinds).toContain("openAck");
    expect(kinds).toContain("response");

    // The end-of-session summary is only honest if the counter matches what
    // actually landed on disk.
    expect(proxy.stats().recorded).toBe(lines.length);
  });

  // The summary's only claim about capture completeness. It must fire when
  // the host socket goes away under a still-connected app (the tail of that
  // session was never seen) and must NOT fire on the ordinary teardown where
  // the app disconnects first.
  it("counts a connection as truncated when upstream closes while the client is still connected", async () => {
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("no");
      },
      websocket: {
        message(ws) {
          // The host hangs up mid-session, exactly as a crashing or updating
          // host daemon would.
          ws.close();
        },
      },
    });
    const upstreamUrl = `ws://127.0.0.1:${upstream.port}/rpc`;
    const recorder = new Recorder(join(dir, "truncated.jsonl"));
    proxy = await startProxyServer({
      upstreamRpcUrl: upstreamUrl,
      upstreamStreamUrl: upstreamUrl.replace("/rpc", "/stream"),
      recorder,
      port: 0,
    });

    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/rpc`);
    client.onopen = () => client.send("hello");

    const started = proxy;
    await waitFor(() => started.stats().truncatedConnections >= 1);
    client.close();
    await recorder.close();

    expect(proxy.stats().truncatedConnections).toBe(1);
  });

  it("does not count a truncated connection when the client disconnects first", async () => {
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
    const recorder = new Recorder(join(dir, "clean-close.jsonl"));
    proxy = await startProxyServer({
      upstreamRpcUrl: upstreamUrl,
      upstreamStreamUrl: upstreamUrl.replace("/rpc", "/stream"),
      recorder,
      port: 0,
    });

    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/rpc`);
    client.onopen = () => client.send("hello");
    await waitFor(() => upstreamReceived.includes("hello"));

    // The ordinary end of a capture: the operator quits the app, so the
    // client leg closes and the proxy tears the upstream socket down after
    // it. That is not a truncated capture and must not be reported as one.
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await recorder.close();

    expect(proxy.stats().truncatedConnections).toBe(0);
  });

  // The probe in clients/shared/host-client/host-activity-probe.ts calls
  // response.json() and requires a boolean `busy`; a body it cannot parse
  // is swallowed and fail-safes to busy. A proxy in use must say busy on
  // purpose, not by accident of a malformed body.
  it("answers GET /activity with a JSON {busy:true} body", async () => {
    proxy = await startProxyServer({
      upstreamRpcUrl: "ws://127.0.0.1:1/rpc",
      upstreamStreamUrl: "ws://127.0.0.1:1/stream",
      recorder: new Recorder(join(dir, "unused.jsonl")),
      port: 0,
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/activity`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ busy: true });
  });

  // A frame the open repo's schemas reject is the discovery this tool
  // exists to make, so it must not be computed and silently discarded.
  it("warns on stderr when a frame fails schema validation", async () => {
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("no");
      },
      websocket: {
        message() {
          // Swallow: only the client->host leg is under test here.
        },
      },
    });
    const upstreamUrl = `ws://127.0.0.1:${upstream.port}/rpc`;
    const recorder = new Recorder(join(dir, "invalid.jsonl"));
    proxy = await startProxyServer({
      upstreamRpcUrl: upstreamUrl,
      upstreamStreamUrl: upstreamUrl.replace("/rpc", "/stream"),
      recorder,
      port: 0,
    });

    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map((arg) => String(arg)).join(" "));
      });
    try {
      const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/rpc`);
      client.onopen = () =>
        client.send(JSON.stringify({ kind: "bogus", method: "host.nope" }));
      await waitFor(() => errors.some((line) => line.includes("host.nope")));
      client.close();
    } finally {
      spy.mockRestore();
    }
    await recorder.close();

    const joined = errors.join("\n");
    expect(joined).toMatch(/rejected by clientFrameSchema/);
    expect(joined).toMatch(/kind=bogus/);
    expect(joined).toMatch(/method=host\.nope/);
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

  it("keeps forwarding when recorder.append() rejects, instead of crashing the process", async () => {
    // A parent path component that is a plain FILE (not a directory) makes
    // Recorder's mkdir(dirname(...), { recursive: true }) reject on every
    // append. This must degrade to "frame missing from the recording",
    // never "proxy process dies" (an unhandled rejection kills a Bun
    // process outright, dropping every active connection).
    const blockerFile = join(dir, "blocker");
    await writeFile(blockerFile, "not a directory");
    const recorder = new Recorder(join(blockerFile, "unwritable", "rec.jsonl"));

    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("no");
      },
      websocket: {
        message(ws, msg) {
          if (String(msg) === "ping") ws.send("pong");
        },
      },
    });
    const upstreamUrl = `ws://127.0.0.1:${upstream.port}/rpc`;
    proxy = await startProxyServer({
      upstreamRpcUrl: upstreamUrl,
      upstreamStreamUrl: upstreamUrl.replace("/rpc", "/stream"),
      recorder,
      port: 0,
    });

    const received: string[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/rpc`);
    client.onopen = () => client.send("ping");
    client.onmessage = (ev) => received.push(String(ev.data));

    // Both directions must still be forwarded despite every append() call
    // rejecting behind the scenes.
    await waitFor(() => received.includes("pong"));
    client.close();

    // The process is still alive and serving new connections — proof that
    // no unhandled rejection took the proxy down.
    const activity = await fetch(`http://127.0.0.1:${proxy.port}/activity`);
    expect(activity.status).toBe(200);
  });

  it("never records a client frame as forwarded once upstream is gone, and survives losing it mid-connection", async () => {
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
    const recFile = join(dir, "stale.jsonl");
    const recorder = new Recorder(recFile);
    proxy = await startProxyServer({
      upstreamRpcUrl: upstreamUrl,
      upstreamStreamUrl: upstreamUrl.replace("/rpc", "/stream"),
      recorder,
      port: 0,
    });

    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/rpc`);
    client.onopen = () => client.send("first");

    await waitFor(() => upstreamReceived.includes("first"));

    // Kill the whole upstream server (not a per-connection close triggered
    // by a client message) and, in the same synchronous burst — no await
    // in between — try to push one more frame through the very connection
    // whose upstream just vanished. This deterministically reproduces the
    // regression: before the fix, `state.upstreamOpen` was only flipped to
    // false from the *callback* that `state.upstream`'s close/error event
    // invokes, so it could still read `true` for a message processed in
    // the same tick as the underlying socket going away. The fix reads
    // `state.upstream.readyState` live at message time instead of a cached
    // flag, so it cannot be stale by even one event-loop turn.
    upstream.stop(true);
    client.send("second");

    // Let everything settle: the close propagating to the client, and any
    // recorder append for "second" that may or may not have happened.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await recorder.close();

    // Process survived losing its upstream mid-connection.
    const activity = await fetch(`http://127.0.0.1:${proxy.port}/activity`);
    expect(activity.status).toBe(200);

    const frames = (await readFile(recFile, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const c2hFrames = frames.filter((f) => f.direction === "c2h");

    // The fidelity property under test: the recording must never claim
    // more frames were forwarded to upstream than upstream actually
    // received. "first" is the only frame that upstream legitimately saw;
    // "second" — sent into a socket the proxy already knows is gone — must
    // not be recorded as if it were successfully forwarded.
    expect(c2hFrames.map((f) => f.payload)).toEqual(["first"]);
    expect(upstreamReceived).toEqual(["first"]);

    // The recorded counter behind the end-of-session summary must not count
    // a frame that was never written.
    expect(proxy.stats().recorded).toBe(frames.length);
  });

  // The stream leg carries binary payloads paired with a text envelope that
  // sets `hasBinaryPayload: true` (protocol
  // `src/framework/stream-ws-protocol.ts`). Anything that routes those bytes
  // through a text type destroys them: `String(buffer)` decodes as UTF-8 and
  // substitutes U+FFFD for every byte that is not valid UTF-8, and the host
  // answers the resulting garbage with STREAM_PROTOCOL_ERROR and tears the
  // stream down under a live app. Every byte below is chosen to be either
  // invalid UTF-8 (0xff, 0xfe, 0x80) or lost/altered by a text round-trip.
  const CLIENT_BINARY = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80, 0x0d, 0x0a, 0x7b, 0x7d,
  ]);
  const HOST_BINARY = new Uint8Array([
    0x00, 0xff, 0xc0, 0xc1, 0xf5, 0x1b, 0x5c, 0x41, 0x00, 0x80,
  ]);

  it("forwards binary frames byte-exact in both directions", async () => {
    const upstreamBinary: Uint8Array[] = [];
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("no");
      },
      websocket: {
        message(ws, msg) {
          if (typeof msg === "string") return;
          upstreamBinary.push(new Uint8Array(msg));
          ws.send(HOST_BINARY);
        },
      },
    });
    const upstreamUrl = `ws://127.0.0.1:${upstream.port}/stream`;
    const recFile = join(dir, "binary.jsonl");
    const recorder = new Recorder(recFile);
    proxy = await startProxyServer({
      upstreamRpcUrl: upstreamUrl.replace("/stream", "/rpc"),
      upstreamStreamUrl: upstreamUrl,
      recorder,
      port: 0,
    });

    const clientBinary: Uint8Array[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/stream`);
    client.binaryType = "arraybuffer";
    client.onopen = () => client.send(CLIENT_BINARY);
    client.onmessage = (ev) => {
      const data: unknown = ev.data;
      if (data instanceof ArrayBuffer) clientBinary.push(new Uint8Array(data));
    };

    await waitFor(() => upstreamBinary.length >= 1 && clientBinary.length >= 1);
    client.close();
    await recorder.close();

    // Byte content, not just length: a UTF-8 round-trip can preserve the byte
    // count of some payloads while replacing their bytes, so a length-only
    // assertion would pass against the broken path.
    expect(Array.from(upstreamBinary[0])).toEqual(Array.from(CLIENT_BINARY));
    expect(Array.from(clientBinary[0])).toEqual(Array.from(HOST_BINARY));
  });

  it("records a binary frame as kind 'binary' with its byte length and no payload content", async () => {
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("no");
      },
      websocket: {
        message(ws, msg) {
          if (typeof msg !== "string") ws.send(HOST_BINARY);
        },
      },
    });
    const upstreamUrl = `ws://127.0.0.1:${upstream.port}/stream`;
    const recFile = join(dir, "binary-record.jsonl");
    const recorder = new Recorder(recFile);
    proxy = await startProxyServer({
      upstreamRpcUrl: upstreamUrl.replace("/stream", "/rpc"),
      upstreamStreamUrl: upstreamUrl,
      recorder,
      port: 0,
    });

    let hostFrames = 0;
    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/stream`);
    client.binaryType = "arraybuffer";
    client.onopen = () => client.send(CLIENT_BINARY);
    client.onmessage = () => {
      hostFrames += 1;
    };

    await waitFor(() => hostFrames >= 1);
    client.close();
    await recorder.close();

    const text = await readFile(recFile, "utf8");
    const frames = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const c2h = frames.find((f) => f.direction === "c2h");
    const h2c = frames.find((f) => f.direction === "h2c");

    expect(c2h.kind).toBe("binary");
    expect(c2h.method).toBeNull();
    expect(c2h.schemaVersion).toBeNull();
    // Byte length only. Binary payload content is opaque to src/scrub.ts and
    // to the fixture guard, so embedding it (base64 or otherwise) would
    // smuggle un-scrubbable bytes past the last gate before a public fork.
    expect(c2h.payload).toEqual({ byteLength: CLIENT_BINARY.byteLength });
    expect(h2c.kind).toBe("binary");
    expect(h2c.payload).toEqual({ byteLength: HOST_BINARY.byteLength });

    // Nothing resembling the bytes themselves reached the recording, in any
    // encoding: neither base64 nor a UTF-8 decode of them appears on disk.
    expect(text).not.toContain(Buffer.from(CLIENT_BINARY).toString("base64"));
    expect(text).not.toContain(Buffer.from(HOST_BINARY).toString("base64"));
  });

  it("flushes buffered text and binary frames byte-exact and in order", async () => {
    const upstreamReceived: Array<
      { type: "text"; value: string } | { type: "binary"; value: number[] }
    > = [];
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("no");
      },
      websocket: {
        message(_ws, msg) {
          if (typeof msg === "string") {
            upstreamReceived.push({ type: "text", value: msg });
            return;
          }
          upstreamReceived.push({
            type: "binary",
            value: Array.from(new Uint8Array(msg)),
          });
        },
      },
    });
    const upstreamUrl = `ws://127.0.0.1:${upstream.port}/stream`;
    const recorder = new Recorder(join(dir, "binary-order.jsonl"));
    proxy = await startProxyServer({
      upstreamRpcUrl: upstreamUrl.replace("/stream", "/rpc"),
      upstreamStreamUrl: upstreamUrl,
      recorder,
      port: 0,
    });

    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/stream`);
    client.onopen = () => {
      // Sent before the proxy's own upstream socket can have finished
      // connecting, so all three take the buffer-until-open path. The real
      // stream protocol pairs an envelope with the binary that follows it, so
      // a buffered binary frame that loses its bytes or its place in the
      // sequence breaks the pairing just as badly as a dropped frame.
      client.send("envelope-before");
      client.send(CLIENT_BINARY);
      client.send("envelope-after");
    };

    await waitFor(() => upstreamReceived.length >= 3);
    client.close();
    await recorder.close();

    expect(upstreamReceived).toEqual([
      { type: "text", value: "envelope-before" },
      { type: "binary", value: Array.from(CLIENT_BINARY) },
      { type: "text", value: "envelope-after" },
    ]);
  });

  it("closes the dialed upstream socket and stays healthy after a failed /rpc upgrade", async () => {
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("no");
      },
      websocket: {
        message(ws, msg) {
          if (String(msg) === "ping") ws.send("pong");
        },
      },
    });
    const upstreamUrl = `ws://127.0.0.1:${upstream.port}/rpc`;
    const recorder = new Recorder(join(dir, "failed-upgrade.jsonl"));
    proxy = await startProxyServer({
      upstreamRpcUrl: upstreamUrl,
      upstreamStreamUrl: upstreamUrl.replace("/rpc", "/stream"),
      recorder,
      port: 0,
    });

    // A plain GET with no Upgrade header cannot be upgraded — this used to
    // leak the outbound dial to the real host daemon that was already
    // opened before the upgrade attempt.
    const res = await fetch(`http://127.0.0.1:${proxy.port}/rpc`);
    expect(res.status).toBe(500);

    // The server must still work afterward: a real websocket connection
    // still forwards successfully.
    const received: string[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/rpc`);
    client.onopen = () => client.send("ping");
    client.onmessage = (ev) => received.push(String(ev.data));

    await waitFor(() => received.includes("pong"));
    client.close();
    await recorder.close();
  });
});
