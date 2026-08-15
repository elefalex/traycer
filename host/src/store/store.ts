import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type StorePaths = { readonly dataDir: string };

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
  } catch {
    return null;
  }
  return parse(JSON.parse(text));
}

/**
 * Write-temp-then-rename, with serialization FIRST. `rename` is atomic within
 * a filesystem, so a hard kill leaves either the old file or the new one and
 * never a half-written one; serializing before the first write means an
 * unserializable value cannot truncate a good file.
 */
export async function writeJson(
  paths: StorePaths,
  name: string,
  value: unknown,
): Promise<void> {
  const text = JSON.stringify(value);
  await mkdir(paths.dataDir, { recursive: true });
  const target = join(paths.dataDir, name);
  const temp = `${target}.tmp`;
  await writeFile(temp, text, "utf8");
  await rename(temp, target);
}
