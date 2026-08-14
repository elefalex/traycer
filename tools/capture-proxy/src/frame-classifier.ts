import {
  clientFrameSchema,
  hostFrameSchema,
} from "@traycer/protocol/framework/ws-protocol";
import type { RecordedFrame } from "./recorder";

type ClassifyInput = {
  readonly raw: string;
  readonly connId: string;
  readonly leg: "rpc" | "stream";
  readonly direction: "c2h" | "h2c";
  readonly ts: number;
};

function readSchemaVersion(
  obj: Record<string, unknown>,
): { major: number; minor: number } | null {
  const sv = obj.schemaVersion;
  if (sv === null || typeof sv !== "object") return null;
  const rec = sv as Record<string, unknown>;
  if (typeof rec.major !== "number" || typeof rec.minor !== "number")
    return null;
  return { major: rec.major, minor: rec.minor };
}

type ClassifyBinaryInput = {
  readonly byteLength: number;
  readonly connId: string;
  readonly leg: "rpc" | "stream";
  readonly direction: "c2h" | "h2c";
  readonly ts: number;
};

/**
 * Records the existence of a binary frame, never its contents.
 *
 * Binary payload bytes are opaque to `./scrub` (which walks JSON keys) and to
 * the committed-fixture guard (`./__tests__/fixtures.test.ts`), so embedding
 * them — base64 or otherwise — would carry un-scrubbable bytes past the last
 * gate before a public fork. What a replay fixture needs from a binary frame
 * is that one occurred here, in this order, this big; that is what is kept.
 *
 * `kind` is a free-form string already carrying sentinels for frames that have
 * no wire `kind` of their own (`"unparseable"`, `"unknown"`), so `"binary"`
 * joins them rather than changing `RecordedFrame`'s shape. The byte count
 * rides in `payload` for the same reason: no new top-level field, and no
 * consumer of the existing ones has to learn a new one.
 */
export function classifyBinaryFrame(input: ClassifyBinaryInput): RecordedFrame {
  return {
    ts: input.ts,
    connId: input.connId,
    leg: input.leg,
    direction: input.direction,
    kind: "binary",
    method: null,
    schemaVersion: null,
    payload: { byteLength: input.byteLength },
  };
}

export function classifyFrame(input: ClassifyInput): {
  frame: RecordedFrame;
  valid: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch {
    return {
      valid: false,
      frame: {
        ts: input.ts,
        connId: input.connId,
        leg: input.leg,
        direction: input.direction,
        kind: "unparseable",
        method: null,
        schemaVersion: null,
        payload: input.raw,
      },
    };
  }
  const obj =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  const schema =
    input.direction === "c2h" ? clientFrameSchema : hostFrameSchema;
  const valid = schema.safeParse(parsed).success;
  return {
    valid,
    frame: {
      ts: input.ts,
      connId: input.connId,
      leg: input.leg,
      direction: input.direction,
      kind: typeof obj.kind === "string" ? obj.kind : "unknown",
      method: typeof obj.method === "string" ? obj.method : null,
      schemaVersion: readSchemaVersion(obj),
      payload: parsed,
    },
  };
}
