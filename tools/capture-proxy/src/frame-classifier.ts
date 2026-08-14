import {
  clientFrameSchema,
  hostFrameSchema,
} from "@traycer/protocol/framework/ws-protocol";
import {
  clientStreamCredentialUpdateFrameSchema,
  clientStreamFatalErrorFrameSchema,
  clientStreamHostCredentialProvisionFrameSchema,
  clientStreamOpenFrameSchema,
  clientStreamSubscribeFrameSchema,
  hostStreamFatalErrorFrameSchema,
  hostStreamOpenAckFrameSchema,
  streamMethodFrameEnvelopeSchema,
} from "@traycer/protocol/framework/stream-ws-protocol";
import type { RecordedFrame } from "./recorder";

type ClassifyInput = {
  readonly raw: string;
  readonly connId: string;
  readonly leg: "rpc" | "stream";
  readonly direction: "c2h" | "h2c";
  readonly ts: number;
};

/**
 * Structural on purpose: it is the whole question this file asks a schema, and
 * stating it this way lets one list hold schemas of differing inferred types
 * without naming zod's internal generics.
 */
type FrameSchema = {
  readonly safeParse: (data: unknown) => { readonly success: boolean };
};

type SchemaSet = {
  /** How the capture warning refers to this set. */
  readonly name: string;
  /** A frame is valid if ANY of these accepts it. */
  readonly schemas: readonly FrameSchema[];
};

/**
 * Host -> client on the stream leg, in the order
 * `clients/shared/host-transport/ws-stream-client.ts` reaches for them.
 *
 * The envelope comes first because it covers every post-`openAck` frame: the
 * transport requires only `kind` + `hasBinaryPayload` and passes the rest
 * through, since the per-method payload kinds (`update`, `snapshot`,
 * `changed`, `ping`, `pong`) are declared by per-stream contracts such as
 * `protocol/src/host/worktree-changed-stream.ts`, not by the transport. So a
 * broad match here is the contract, not a hole in it — the proxy holds a
 * stream frame to exactly what the real client holds it to.
 */
const HOST_STREAM_SCHEMAS: readonly FrameSchema[] = [
  streamMethodFrameEnvelopeSchema,
  hostStreamOpenAckFrameSchema,
  hostStreamFatalErrorFrameSchema,
];

/** Client -> host on the stream leg: the control frames it may emit. */
const CLIENT_STREAM_SCHEMAS: readonly FrameSchema[] = [
  clientStreamOpenFrameSchema,
  clientStreamSubscribeFrameSchema,
  clientStreamCredentialUpdateFrameSchema,
  clientStreamHostCredentialProvisionFrameSchema,
  clientStreamFatalErrorFrameSchema,
];

/**
 * Which schemas judge a frame — the leg decides, not just the direction.
 *
 * `clientFrameSchema` / `hostFrameSchema` are the `/rpc` transport envelope
 * and say nothing about `/stream`, which is a separate wire contract with its
 * own control frames. Judging stream traffic by the rpc union produced 224
 * bogus "frame rejected" warnings in a live capture, all of them on
 * `leg=stream` and none on `leg=rpc` — the proxy's bug, not protocol drift.
 *
 * The stream leg has no single union to parse against; the real client tries
 * schemas in turn, so this does the same and accepts a frame any of them
 * accepts.
 */
function schemasFor(
  leg: "rpc" | "stream",
  direction: "c2h" | "h2c",
): SchemaSet {
  if (leg === "rpc") {
    return direction === "c2h"
      ? { name: "clientFrameSchema", schemas: [clientFrameSchema] }
      : { name: "hostFrameSchema", schemas: [hostFrameSchema] };
  }
  return direction === "c2h"
    ? { name: "clientStreamFrameSchemas", schemas: CLIENT_STREAM_SCHEMAS }
    : { name: "hostStreamFrameSchemas", schemas: HOST_STREAM_SCHEMAS };
}

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

export type ClassifiedFrame = {
  readonly frame: RecordedFrame;
  readonly valid: boolean;
  /** Name of the schema set `valid` was decided by, for the capture warning. */
  readonly validatedBy: string;
};

export function classifyFrame(input: ClassifyInput): ClassifiedFrame {
  const schemaSet = schemasFor(input.leg, input.direction);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch {
    return {
      valid: false,
      validatedBy: schemaSet.name,
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
  const valid = schemaSet.schemas.some(
    (schema) => schema.safeParse(parsed).success,
  );
  return {
    valid,
    validatedBy: schemaSet.name,
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
