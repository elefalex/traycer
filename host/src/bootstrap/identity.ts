import { randomUUID } from "node:crypto";
import { readJson, writeJson, type StorePaths } from "../store/store";

export type HostIdentity = { readonly hostId: string };

/**
 * Narrows `raw` to `HostIdentity` without an `as` cast, mirroring
 * `isErrorWithCode` in store.ts: the `in` check lets the compiler synthesize
 * a `{ hostId: unknown }` shape, so `raw.hostId` is readable without
 * asserting a type onto it.
 */
function parseIdentity(raw: unknown): HostIdentity {
  if (typeof raw !== "object" || raw === null || !("hostId" in raw)) {
    throw new Error("identity.json is missing hostId");
  }
  if (typeof raw.hostId !== "string") {
    throw new Error("identity.json hostId must be a string");
  }
  return { hostId: raw.hostId };
}

/**
 * `hostId` is canonical host identity, and a GUI tab binds to it for the
 * tab's lifetime once opened (`useTabHostId()` reads it once and holds it —
 * clients/gui-app/src/components/epic-canvas/hooks/use-tab-host-id.ts:15-23,
 * fed by `<TabHostProvider>` —
 * clients/gui-app/src/components/epic-canvas/tab-host-provider.tsx:27-33).
 * Silently minting a new `hostId` here would orphan every tab already bound
 * to the old one.
 *
 * `readJson` (../store/store.ts) propagates every error except ENOENT, so an
 * unreadable-but-present identity.json surfaces here as a thrown error
 * rather than looking like "no identity yet" — catching broadly and minting
 * a fresh id on any failure would reintroduce exactly that bug.
 */
export async function loadOrCreateIdentity(
  paths: StorePaths,
): Promise<HostIdentity> {
  const existing = await readJson(paths, "identity.json", parseIdentity);
  if (existing !== null) return existing;
  const identity: HostIdentity = { hostId: randomUUID() };
  await writeJson(paths, "identity.json", identity);
  return identity;
}
