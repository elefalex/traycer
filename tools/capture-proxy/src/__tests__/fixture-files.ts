import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every `.jsonl` file under `dir`, at any depth, as absolute paths.
 *
 * Recursive on purpose: the committed-fixture guard is the last gate before a
 * recording reaches this public fork, and a non-recursive scan would leave a
 * fixture filed under `fixtures/<scenario>/` silently unguarded — passing the
 * suite while carrying live credentials, which is the worst way for a gate to
 * fail.
 *
 * Symlinked directories are not followed (`isDirectory()` is false for a
 * symlink), so a stray link cannot send the walk outside `fixtures/` or into
 * a cycle. Paths are sorted so a failure names the same file on every run.
 */
export function listJsonlFilesRecursively(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listJsonlFilesRecursively(full));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      found.push(full);
    }
  }
  return found.sort();
}
