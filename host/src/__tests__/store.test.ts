import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJson, resolveDataDir, writeJson } from "../store/store";

function asRecord(raw: unknown): { readonly v: number } {
  if (typeof raw !== "object" || raw === null || !("v" in raw)) {
    throw new Error("bad shape");
  }
  const v = (raw as { v: unknown }).v;
  if (typeof v !== "number") throw new Error("bad shape");
  return { v };
}

describe("store", () => {
  it("defaults to ~/.traycer-open and never ~/.traycer", () => {
    const dir = resolveDataDir(null);
    expect(dir).toBe(join(homedir(), ".traycer-open"));
    expect(dir).not.toBe(join(homedir(), ".traycer"));
  });

  it("honours an explicit override", () => {
    expect(resolveDataDir("/tmp/elsewhere")).toBe("/tmp/elsewhere");
  });

  it("round-trips a value", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "open-host-store-"));
    await writeJson({ dataDir }, "thing.json", { v: 7 });
    expect(await readJson({ dataDir }, "thing.json", asRecord)).toEqual({ v: 7 });
  });

  it("returns null for an absent file rather than throwing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "open-host-store-"));
    expect(await readJson({ dataDir }, "nope.json", asRecord)).toBeNull();
  });

  it("leaves no temp file behind after a write", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "open-host-store-"));
    await writeJson({ dataDir }, "thing.json", { v: 1 });
    expect(await readdir(dataDir)).toEqual(["thing.json"]);
  });

  it("does not corrupt an existing file when the new value fails to serialize", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "open-host-store-"));
    await writeJson({ dataDir }, "thing.json", { v: 1 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(writeJson({ dataDir }, "thing.json", circular)).rejects.toThrow();
    expect(await readFile(join(dataDir, "thing.json"), "utf8")).toBe(
      JSON.stringify({ v: 1 }),
    );
  });
});
