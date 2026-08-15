import {
  splitConnectionManifest,
  type SplitConnectionManifest,
} from "@traycer/protocol/framework/capability-manifest";
import { check } from "@traycer/protocol/framework/compatibility-checker";
import {
  clientOpenFrameSchema,
  type HostFatalErrorFrame,
  type HostOpenAckFrame,
} from "@traycer/protocol/framework/ws-protocol";
import { hostRpcRegistry } from "@traycer/protocol/host";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

/**
 * Outcome of handling an inbound `open` frame: either an `openAck` to send
 * back, or a `fatalError` frame to send back immediately before closing the
 * socket (structurally invalid frame, or an incompatible manifest).
 */
export type HandshakeOutcome =
  | { readonly kind: "openAck"; readonly frame: HostOpenAckFrame }
  | { readonly kind: "fatalError"; readonly frame: HostFatalErrorFrame };

/**
 * Built from the SAME registry + floor constant the client uses
 * (`clients/shared/host-transport/ws-rpc-client.ts:429-430`), so the required
 * manifests are name-identical and version-identical by construction. A
 * hand-maintained list here could only ever drift out of compatibility.
 *
 * `optionalManifest` is deliberately empty: the compatibility check compares
 * required manifests only (`ws-rpc-client.ts:360-365`), and a method the host
 * does not advertise degrades gracefully via
 * `executeUnavailableMethodDegrade` (`ws-rpc-client.ts:395-408`) instead of
 * erroring at call time. Advertising an unimplemented method would turn a
 * clean degrade into a runtime failure.
 */
export function buildHostManifest(): SplitConnectionManifest {
  const split = splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
  );
  return { manifest: split.manifest, optionalManifest: {} };
}

/**
 * Handles the client's first frame on `/rpc`
 * (`clientOpenFrameSchema` — protocol/src/framework/ws-protocol.ts:232).
 *
 * The bearer `token` is read and discarded: it is a live cloud credential in
 * real usage (the capture fixtures redact it for exactly this reason), and
 * this host does not verify it.
 *
 * Two ways to fail, both terminal for the connection:
 * - The frame does not parse against `clientOpenFrameSchema` at all — the
 *   client sent something structurally invalid.
 * - The frame parses, but `check()` (compatibility-checker.ts:42, run with
 *   `selfRole: "host"`) finds a method in the union of the two manifests that
 *   one side lacks or that neither side can bridge.
 *
 * A parsed, compatible frame produces `openAck`
 * (`hostOpenAckFrameSchema` — ws-protocol.ts:266) carrying exactly
 * `{kind, manifest, optionalManifest}` — no version or hostId field, matching
 * the real recorded host's wire payload.
 */
export function handleOpenFrame(raw: unknown): HandshakeOutcome {
  const parsed = clientOpenFrameSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      kind: "fatalError",
      frame: {
        kind: "fatalError",
        details: {
          code: "PROTOCOL_ERROR",
          reason: `Malformed open frame: ${parsed.error.message}`,
          incompatibleMethods: null,
          upgradeGuidance: null,
        },
      },
    };
  }

  const ours = buildHostManifest();
  const compat = check(
    hostRpcRegistry,
    ours.manifest,
    parsed.data.manifest,
    "host",
  );
  if (!compat.ok) {
    return {
      kind: "fatalError",
      frame: { kind: "fatalError", details: compat.details },
    };
  }

  return {
    kind: "openAck",
    frame: {
      kind: "openAck",
      manifest: ours.manifest,
      optionalManifest: ours.optionalManifest,
    },
  };
}
