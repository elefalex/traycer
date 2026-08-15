import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeJson, type StorePaths } from "../store/store";

/**
 * Narrows a caught `unknown` to "this is a Node filesystem error with the
 * given `code`" without an `as` cast — same idiom as `isErrorWithCode` in
 * store.ts, duplicated locally since store.ts does not export it.
 */
function isErrorWithCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === code;
}

/**
 * Field set taken from `HostPidMetadata`
 * (clients/shared/host-lifecycle/shared/host-process.ts:16-30), whose
 * decoder's required-field check
 * (host-process.ts:103-109) demands `pid` (number), `hostId`, `version`,
 * `websocketUrl`, `startedAt` (strings) — this file is the desktop client's
 * only discovery channel for the host's websocket URL, so getting this
 * field set exactly right is load-bearing.
 *
 * `HostPidMetadata` also carries `processStartTimeMs: number | null`
 * (host-process.ts:23), which this task intentionally omits: the decoder
 * treats a missing/non-number value as `null` and never as a decode failure
 * (host-process.ts:112-118, "never corrupt/malformed") — an additive field
 * that fails open when absent, the same contract `processStartIdentity`
 * gets below.
 *
 * `processStartIdentity` is nullable on the client type
 * (host-process.ts:29), and the decoder defaults any non-matching value to
 * `null` rather than rejecting the record (host-process.ts:128-130). A
 * previous capture against the real signed host established empirically
 * that an absent/invalid `processStartIdentity` fails **open** on the
 * client — so this host writes `null` rather than fabricate one.
 */
export type PidMetadata = {
  readonly pid: number;
  readonly hostId: string;
  readonly version: string;
  readonly websocketUrl: string;
  readonly startedAt: string;
  readonly processStartIdentity: null;
};

/**
 * Delegates to `writeJson` (../store/store.ts) so `pid.json` inherits its
 * write-temp-then-rename atomicity: the desktop client has no fallback
 * discovery path, so it must never observe a half-written file.
 */
export async function writePidFile(
  paths: StorePaths,
  meta: PidMetadata,
): Promise<void> {
  await writeJson(paths, "pid.json", meta);
}

export async function removePidFile(paths: StorePaths): Promise<void> {
  try {
    await unlink(join(paths.dataDir, "pid.json"));
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) return;
    throw error;
  }
}
