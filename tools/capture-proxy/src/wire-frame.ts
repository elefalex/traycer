/**
 * A websocket frame in the form the socket delivered it.
 *
 * The distinction is load-bearing rather than cosmetic. The stream leg carries
 * binary payloads paired with a text envelope that sets `hasBinaryPayload:
 * true` (`streamMethodFrameEnvelopeSchema` in
 * `protocol/src/framework/stream-ws-protocol.ts`). Coercing such a frame with
 * `String(...)` decodes it as UTF-8 and replaces every byte that is not valid
 * UTF-8 with U+FFFD, so the bytes forwarded on are not the bytes received; the
 * host rejects the result with `STREAM_PROTOCOL_ERROR` and tears the stream
 * down under a live app. Binary frames therefore never touch a text type here.
 *
 * `bytes` is pinned to an `ArrayBuffer`-backed view because that is what both
 * send paths accept — the client `WebSocket` and Bun's `ServerWebSocket` — so
 * forwarding needs no cast to reach either of them.
 */
export type WireFrame =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "binary"; readonly bytes: Uint8Array<ArrayBuffer> };

/**
 * Copies a delivered binary frame into bytes this proxy owns.
 *
 * The copy is what makes a frame safe to hold past the callback that delivered
 * it: Bun hands the `message` callback a view over a receive buffer it is free
 * to reuse for the next frame, so a frame queued by the buffer-until-open path
 * would otherwise flush whatever arrived after it. It is a byte-for-byte
 * `memcpy`, never a re-encode — the bytes that go out are the bytes that came
 * in.
 */
function ownBytes(
  source: ArrayBufferView | ArrayBuffer,
): Uint8Array<ArrayBuffer> {
  const view =
    source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : // Only this view's own window, not the whole backing buffer: a pooled
        // `Buffer` sits at a non-zero offset inside a buffer shared with other
        // frames.
        new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  const owned = new Uint8Array(view.byteLength);
  owned.set(view);
  return owned;
}

/**
 * Classifies whatever a websocket handed us without altering it.
 *
 * Bun delivers binary as a `Buffer` (a `Uint8Array` view) on the server side
 * and as an `ArrayBuffer` on the client side once `binaryType` is pinned to
 * `"arraybuffer"`, so `instanceof ArrayBuffer` alone is not sufficient — both
 * shapes are handled.
 */
export function toWireFrame(data: unknown): WireFrame {
  if (typeof data === "string") {
    return { type: "text", text: data };
  }
  if (ArrayBuffer.isView(data)) {
    return { type: "binary", bytes: ownBytes(data) };
  }
  if (data instanceof ArrayBuffer) {
    return { type: "binary", bytes: ownBytes(data) };
  }
  // Unreachable with the sockets this proxy owns: the server side yields
  // `string | Buffer` and every client socket it opens pins `binaryType` to
  // `"arraybuffer"`, so the only remaining shape (`Blob`) is never produced.
  // Kept as a total fallback rather than a throw, because a frame that somehow
  // reaches here must still be forwarded rather than kill the capture.
  return { type: "text", text: String(data) };
}
