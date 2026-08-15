import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type StorePaths = { readonly dataDir: string };

/**
 * Narrows a caught `unknown` to "this is a Node filesystem error with the
 * given `code`" without an `as` cast: the `in` check lets the compiler
 * synthesize a `{ code: unknown }` shape on `error`, so `error.code` is
 * readable and comparable without asserting a type onto it.
 */
function isErrorWithCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === code;
}

/**
 * `~/.traycer-open`, deliberately NOT `~/.traycer`: the proprietary install
 * must stay usable side by side with the open host on the same machine.
 */
export function resolveDataDir(override: string | null): string {
  if (override !== null) return override;
  return join(homedir(), ".traycer-open");
}

export async function readJson<T>(
  paths: StorePaths,
  name: string,
  parse: (raw: unknown) => T,
): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(join(paths.dataDir, name), "utf8");
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) return null;
    // Anything other than "file does not exist" (permissions, EIO, ...) must
    // propagate: swallowing it here is indistinguishable from "no file yet"
    // to a caller like Task 4's `loadOrCreateIdentity`, which would silently
    // mint a fresh `hostId` instead of surfacing the read failure.
    throw error;
  }
  return parse(JSON.parse(text));
}

/**
 * Write-temp-then-rename, with serialization FIRST. `rename` is atomic within
 * a filesystem, so a hard kill leaves either the old file or the new one and
 * never a half-written one; serializing before the first write means an
 * unserializable value cannot truncate a good file.
 *
 * The temp name carries a per-call random suffix (`randomUUID`) and stays in
 * the SAME directory as the target: uniqueness stops two concurrent writers
 * to the same key from racing over one shared temp path (the loser's
 * `rename` would otherwise hit an ENOENT because the winner already
 * consumed it, dropping the loser's write silently); same-directory keeps
 * the `rename` atomic, since that guarantee only holds within one
 * filesystem.
 */
export async function writeJson(
  paths: StorePaths,
  name: string,
  value: unknown,
): Promise<void> {
  const text = JSON.stringify(value);
  await mkdir(paths.dataDir, { recursive: true });
  const target = join(paths.dataDir, name);
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, text, "utf8");
  await rename(temp, target);
}
