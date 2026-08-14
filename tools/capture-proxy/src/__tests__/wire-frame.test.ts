import { describe, expect, it } from "vitest";
import { toWireFrame } from "../wire-frame";

// Bytes that a UTF-8 round-trip cannot survive: 0xff/0xfe/0x80 are not valid
// UTF-8 and decode to U+FFFD, which is what corrupted the live capture.
const BYTES = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x41, 0x0d, 0x0a]);

function bytesOf(data: unknown): number[] {
  const frame = toWireFrame(data);
  if (frame.type !== "binary") throw new Error("expected a binary frame");
  return Array.from(frame.bytes);
}

describe("toWireFrame", () => {
  it("keeps a text frame as its exact string", () => {
    expect(toWireFrame('{"kind":"ping"}')).toEqual({
      type: "text",
      text: '{"kind":"ping"}',
    });
  });

  it("keeps a Buffer (Bun's server-side binary shape) byte-exact", () => {
    expect(bytesOf(Buffer.from(BYTES))).toEqual(Array.from(BYTES));
  });

  it("keeps an ArrayBuffer (Bun's client-side binary shape) byte-exact", () => {
    const buffer = new ArrayBuffer(BYTES.byteLength);
    new Uint8Array(buffer).set(BYTES);
    expect(bytesOf(buffer)).toEqual(Array.from(BYTES));
  });

  it("reads only its own window of a view into a larger buffer", () => {
    // A `Buffer` from a pooled allocator is a view at a non-zero offset into a
    // buffer shared with other frames. Reading the whole backing buffer would
    // splice its neighbours into this frame.
    const backing = new Uint8Array([0xaa, 0xbb, ...BYTES, 0xcc]);
    expect(bytesOf(backing.subarray(2, 2 + BYTES.byteLength))).toEqual(
      Array.from(BYTES),
    );
  });

  it("owns its bytes, so a reused receive buffer cannot rewrite a queued frame", () => {
    const receiveBuffer = new Uint8Array(BYTES);
    const frame = toWireFrame(receiveBuffer);
    // Bun reuses the receive buffer for the next frame; a frame waiting in the
    // buffer-until-open outbox must still hold what actually arrived.
    receiveBuffer.fill(0);
    if (frame.type !== "binary") throw new Error("expected a binary frame");
    expect(Array.from(frame.bytes)).toEqual(Array.from(BYTES));
  });
});
