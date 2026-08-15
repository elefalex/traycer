import { afterEach, describe, expect, it } from "vitest";
import { startListener, type Listener } from "../server/listener";

const noop = (): void => {};
let listener: Listener | null = null;

afterEach(async () => {
  await listener?.stop();
  listener = null;
});

describe("listener", () => {
  it("binds an ephemeral loopback port and advertises a /rpc url", () => {
    listener = startListener({ onRpcMessage: noop, onStreamMessage: noop });
    expect(listener.port).toBeGreaterThan(0);
    expect(listener.websocketUrl).toBe(`ws://127.0.0.1:${listener.port}/rpc`);
  });

  it("answers GET /activity with a parseable busy:false", async () => {
    listener = startListener({ onRpcMessage: noop, onStreamMessage: noop });
    const response = await fetch(`http://127.0.0.1:${listener.port}/activity`);
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ busy: false });
  });

  it("routes a /rpc frame to the rpc handler only", async () => {
    const seen: string[] = [];
    listener = startListener({
      onRpcMessage: (send, raw) => {
        seen.push(`rpc:${raw}`);
        send("ack");
      },
      onStreamMessage: (send, raw) => {
        seen.push(`stream:${raw}`);
      },
    });
    const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/rpc`);
    await new Promise((r) =>
      socket.addEventListener("open", r, { once: true }),
    );
    const reply = new Promise<string>((r) =>
      socket.addEventListener("message", (e) => r(String(e.data)), {
        once: true,
      }),
    );
    socket.send("hello");
    expect(await reply).toBe("ack");
    expect(seen).toEqual(["rpc:hello"]);
    socket.close();
  });

  it("routes a /stream frame to the stream handler only", async () => {
    const seen: string[] = [];
    listener = startListener({
      onRpcMessage: (send, raw) => seen.push(`rpc:${raw}`),
      onStreamMessage: (send, raw) => {
        seen.push(`stream:${raw}`);
        send("ack");
      },
    });
    const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/stream`);
    await new Promise((r) =>
      socket.addEventListener("open", r, { once: true }),
    );
    const reply = new Promise<string>((r) =>
      socket.addEventListener("message", (e) => r(String(e.data)), {
        once: true,
      }),
    );
    socket.send("hello");
    expect(await reply).toBe("ack");
    expect(seen).toEqual(["stream:hello"]);
    socket.close();
  });

  it("rejects an unknown path", async () => {
    listener = startListener({ onRpcMessage: noop, onStreamMessage: noop });
    const response = await fetch(`http://127.0.0.1:${listener.port}/nope`);
    expect(response.status).toBe(404);
  });
});
