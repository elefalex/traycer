import {
  clientRequestFrameSchema,
  type HostResponseFrame,
} from "@traycer/protocol/framework/ws-protocol";

/** A domain handler for one RPC method. Params are unvalidated at this layer. */
export type MethodHandler = (params: unknown) => Promise<unknown>;

/** Method name -> handler. Built up across Tasks 8-11. */
export type MethodTable = ReadonlyMap<string, MethodHandler>;

/**
 * Narrows a caught `unknown` to a human-readable message without an `as`
 * cast, mirroring `isErrorWithCode` in `store/store.ts`: a thrown `Error`
 * yields its `.message`, anything else (a thrown string, object, etc.) is
 * stringified so the error frame's `message` is always a string.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function successFrame(
  requestId: string,
  method: string,
  schemaVersion: HostResponseFrame["schemaVersion"],
  result: unknown,
): HostResponseFrame {
  return {
    kind: "response",
    requestId,
    method,
    schemaVersion,
    result,
    error: null,
  };
}

function errorFrame(
  requestId: string,
  method: string,
  schemaVersion: HostResponseFrame["schemaVersion"],
  code: string,
  message: string,
): HostResponseFrame {
  return {
    kind: "response",
    requestId,
    method,
    schemaVersion,
    result: null,
    error: { code, message },
  };
}

/**
 * Builds the dispatcher that sits between the `/rpc` listener leg
 * (`server/listener.ts`'s `onRpcMessage`) and the domain method table.
 *
 * Frame shapes: `clientRequestFrameSchema`
 * (`protocol/src/framework/ws-protocol.ts:240`) in,
 * `hostResponseFrameSchema` shape (`:284`, error payload `:278`) out — a real
 * recorded success frame carries `error: null`, which is why the success path
 * below sets it explicitly rather than omitting the key.
 *
 * Error handling, in order:
 * - Unparseable JSON, or JSON that does not match `clientRequestFrameSchema`
 *   (wrong `kind`, missing `requestId`/`method`/`schemaVersion`, ...): DROP.
 *   Returns `null`, no reply sent, connection stays open. One malformed frame
 *   must never tear down every other in-flight request on the same socket.
 * - No handler registered for `method`: this milestone advertises all 113
 *   floor methods in the manifest but has not implemented all of them yet, so
 *   this is a backlog item, not a capability statement — the wire code is
 *   `"RPC_ERROR"` (`RPC_ERROR_CODES`,
 *   `protocol/src/framework/versioned-rpc-types.ts:14`), never
 *   `"E_HOST_UNSUPPORTED"` (that code is reserved for a method genuinely
 *   absent from the manifest, which the GUI may hide affordances for
 *   permanently). Logged via `console.warn` — one line per occurrence, never
 *   batched or deduped — because Task 13's traffic replay and the manual
 *   acceptance pass both read this log as the literal backlog of
 *   not-yet-implemented methods.
 * - Handler throws (sync or rejected promise): caught and converted to an
 *   `RPC_ERROR` response frame carrying the thrown message. Never propagates
 *   past the dispatcher — one bad handler must not crash the process or the
 *   connection.
 *
 * The response always echoes back the REQUESTED `schemaVersion`, not this
 * host's canonical version for the method: the capture shows a real client
 * requesting `worktree.listAllForHost` at 1.4 while this repo's canonical is
 * 1.5, and answering at a version the caller did not ask for is a silent
 * contract break.
 */
export function createDispatcher(
  table: MethodTable,
): (raw: string) => Promise<string | null> {
  return async (raw: string): Promise<string | null> => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return null;
    }

    const parsed = clientRequestFrameSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return null;
    }

    const { requestId, method, schemaVersion, params } = parsed.data;
    const handler = table.get(method);

    if (handler === undefined) {
      console.warn(
        `[rpc] unimplemented method requested: ${method} v${schemaVersion.major}.${schemaVersion.minor} (requestId=${requestId})`,
      );
      return JSON.stringify(
        errorFrame(
          requestId,
          method,
          schemaVersion,
          "RPC_ERROR",
          `no handler registered for method "${method}"`,
        ),
      );
    }

    try {
      const result = await handler(params);
      return JSON.stringify(
        successFrame(requestId, method, schemaVersion, result),
      );
    } catch (error) {
      return JSON.stringify(
        errorFrame(
          requestId,
          method,
          schemaVersion,
          "RPC_ERROR",
          describeError(error),
        ),
      );
    }
  };
}
