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
