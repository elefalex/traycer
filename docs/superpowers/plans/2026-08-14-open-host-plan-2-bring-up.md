---
project: traycer
type: plan
status: active
date: 2026-08-14
title: Open Host Plan 2 — Bring-up to GUI-renders
summary: Build the open host's bootstrap, JSON WebSocket server, handshake, dispatcher and boot-tier RPC methods until the desktop app connects and renders its main UI with no agent.
---

# Open Host Plan 2 — Bring-up to GUI-renders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `make dev-open` launches the desktop app against an in-repo open host; the app completes the handshake, answers its boot RPC sequence, and renders the main UI with no agent running.

**Architecture:** A Bun daemon at `host/` that imports `@traycer/protocol` from TypeScript source. It publishes `pid.json` (the client's only discovery channel), serves `GET /activity` plus `ws://127.0.0.1:<port>/rpc` and `/stream`, and answers the handshake by building its manifest from the very same `hostRpcRegistry` + `RELEASED_FLOOR_METHOD_NAMES` the client uses — which makes compatibility true by construction rather than by transcription. Domain logic is implemented only for the methods the capture proves the GUI actually calls; every other floor method is advertised but returns a well-formed error, and the error log is the backlog.

**Tech Stack:** Bun 1.3.12 workspaces, Nx, TypeScript, vitest, zod (via `@traycer/protocol`), Electron desktop client (unmodified except one flag-gated auth patch).

## What the Plan 1 capture established

Every number below is measured from `tools/capture-proxy/fixtures/`, not assumed. Tasks cite these instead of re-deriving them.

| Fact | Value | Consequence for this plan |
|---|---|---|
| Client required manifest | exactly **113** methods | Host MUST advertise all 113 or the client hard-fatals `INCOMPATIBLE` |
| Client vs host required manifest names | **set-identical** | Both sides call `splitConnectionManifest(hostRpcRegistry, RELEASED_FLOOR_METHOD_NAMES)`; no hand-written list is ever correct |
| Distinct RPC methods actually called | **22** across boot + task flow | Only these need real logic in milestones 1–2 |
| Of those, floor vs optional | **20 floor, 2 optional** | `optionalManifest` can ship **empty**; the 2 optional ones degrade |
| Stream methods in registry vs used at boot | **25 registered, 2 used** | Only `worktree.changed` and `resources.subscribe` matter here |
| Stream `openAck.hostCredentialState` | `null` = "do not provision" | The open host never triggers the refresh-token flow |
| Installed host version vs repo protocol | host older on **14** methods | An open host built from this repo matches the client exactly and needs **no** version bridging |

## Global Constraints

- **Bun 1.3.12 + Nx workspaces.** Run tests with `bun --bun vitest run` — plain `bunx vitest` runs under Node, where `Bun.serve` does not exist and every server test fails for the wrong reason.
- **Never run `compile`/`build`/`lint`/`format` manually before committing.** `pre-commit` runs the affected workspace checks. Only re-run a check yourself when diagnosing a hook or CI failure.
- **Every commit needs DCO:** `git commit -s`.
- **STANDING RULE (carried forward from Plan 1, non-negotiable):** any task that encodes an assumption about protocol shape MUST cite the `protocol/src/...` file and line that backs it, in a code comment or the commit message. Three of Plan 1's most serious defects came from designing against an imagined wire while eight reviews checked code-against-plan and never code-against-`protocol/src`. A task whose report cites no schema line for a wire claim is not done.
- **Never `git add -A` or `git add .`.** Stage by explicit path. `tools/capture-proxy/fixtures/` is tracked and `recordings/` is not; one careless add publishes raw capture data.
- **Type safety (ESLint, do not bypass):** no optional params (`x?: T` → `x: T | undefined`), no default params, no `as any` / `as unknown`, no `ReturnType<typeof fn>` — name the concrete type.
- **The host makes no network calls.** No cloud auth, no sync, no telemetry, no rate-limit metering. A domain module that wants to reach the internet is a bug in this milestone.
- **Host data lives under `~/.traycer-open/`**, never `~/.traycer/` — the real install must stay usable side by side.
- **The bearer token in every `open` frame is accepted and ignored.** Never verify it, never log it.

---

### Task 1: Close Plan 1's carried-forward debt — `main.ts` subprocess test

Plan 1's final review accepted a coverage gap in `tools/capture-proxy/src/main.ts` on the grounds that it was a one-shot tool, on the explicit condition that the gap must not survive into Plans 2–3. This task closes it before new infrastructure lands.

**Files:**
- Create: `tools/capture-proxy/src/__tests__/main-subprocess.test.ts`

**Interfaces:**
- Consumes: `tools/capture-proxy/src/main.ts` (Plan 1), invoked as a real subprocess.
- Produces: nothing importable — this is a regression gate only.

- [ ] **Step 1: Write the failing test**

The point is that `main.ts` restores `pid.json` on signal-driven exit. Do not import `main.ts` — spawn it, so the entrypoint's own signal wiring is what gets exercised. That is precisely what a unit test could not reach and why the gap was worth closing.

`tools/capture-proxy/src/__tests__/main-subprocess.test.ts`:
```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ENTRYPOINT = join(__dirname, "..", "main.ts");

async function waitForRewrite(
  pidPath: string,
  original: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await readFile(pidPath, "utf8");
    if (current !== original) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("proxy never rewrote pid.json");
}

describe("main.ts as a subprocess", () => {
  it("restores pid.json when terminated by a signal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capture-proxy-main-"));
    const pidPath = join(dir, "pid.json");
    const original = JSON.stringify({
      pid: 4242,
      hostId: "test-host",
      version: "0.0.0-test",
      websocketUrl: "ws://127.0.0.1:59999/rpc",
      startedAt: new Date(0).toISOString(),
      processStartIdentity: null,
    });
    await writeFile(pidPath, original, "utf8");

    const child = Bun.spawn(
      ["bun", ENTRYPOINT, "--pid-file", pidPath, "--out", join(dir, "o.jsonl")],
      { stdout: "pipe", stderr: "pipe" },
    );

    // The child MUST be reaped on every path. `waitForRewrite` throws on a
    // slow box or on the very regression this test exists to catch, and
    // `child.exited` is unbounded if main.ts hangs on SIGTERM — either way the
    // test would fail while leaking a live process holding an open port and a
    // live pid.json. Vitest does not reap processes spawned via `Bun.spawn`.
    try {
      await waitForRewrite(pidPath, original, 5_000);
      child.kill("SIGTERM");
      await child.exited;

      expect(await readFile(pidPath, "utf8")).toBe(original);
    } finally {
      child.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
```

- [ ] **Step 2: Run it and read the failure honestly**

Run: `bun --bun vitest run --root tools/capture-proxy -t "subprocess"`

This test may pass on the first run — the restore logic already exists; only its coverage was missing. That is a legitimate outcome for a regression gate over shipped behaviour, and you must NOT manufacture a red phase by breaking `main.ts`.

What you MUST verify instead is that the test can fail for the right reason. Temporarily edit `main.ts` to skip the restore, confirm this test fails, then revert the edit with `git checkout tools/capture-proxy/src/main.ts` and confirm it passes again. Record both observations in your report. A test that passes identically with and without the behaviour it claims to guard is worthless, and this is the one cheap way to prove it is not.

- [ ] **Step 3: Run the package suite**

Run: `bun --bun vitest run --root tools/capture-proxy`
Expected: PASS, 188 tests (187 from Plan 1 plus this one).

- [ ] **Step 4: Commit**

```bash
git add tools/capture-proxy/src/__tests__/main-subprocess.test.ts
git commit -s -m "cover capture proxy entrypoint restore with a subprocess test"
```

---

### Task 2: `host/` package scaffold

**Files:**
- Create: `host/package.json`
- Create: `host/tsconfig.json`
- Create: `host/project.json`
- Create: `host/vitest.config.ts`
- Create: `host/src/index.ts`
- Test: `host/src/__tests__/protocol-wiring.test.ts`

**Interfaces:**
- Produces: the `@traycer/open-host` workspace package, importable as `@traycer/protocol/...` consumer. Every later task adds files under `host/src/`.

- [ ] **Step 1: Read how a sibling package is wired**

Read `tools/capture-proxy/package.json`, `tools/capture-proxy/tsconfig.json`, and `tools/capture-proxy/project.json`. Mirror their structure — same module resolution, same Nx target names, same vitest setup. Do not invent a new layout; the repo's `pre-commit` and Nx affected-detection both key off these conventions.

Note the package name difference: capture-proxy is a throwaway dev tool, the host is a product package. Name it `@traycer/open-host` (matching the spec's `host/` = `@traycer/open-host`), NOT `@traycer-clients/...` — it is not a client.

- [ ] **Step 2: Write the wiring test first**

This test is the whole point of the scaffold: prove the host can import the protocol from TypeScript source (no build step), and pin the two facts every later task depends on.

`host/src/__tests__/protocol-wiring.test.ts`:
```ts
import { hostRpcRegistry, hostStreamRpcRegistry } from "@traycer/protocol/host";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { describe, expect, it } from "vitest";

describe("protocol wiring", () => {
  it("imports the host registries from TypeScript source", () => {
    expect(Object.keys(hostRpcRegistry).length).toBeGreaterThan(0);
    expect(Object.keys(hostStreamRpcRegistry)).toHaveLength(25);
  });

  it("pins the released floor at the size the capture measured", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).toHaveLength(113);
  });

  it("has a floor that is a subset of the registry", () => {
    const registered = new Set(Object.keys(hostRpcRegistry));
    const missing = RELEASED_FLOOR_METHOD_NAMES.filter(
      (name) => !registered.has(name),
    );
    expect(missing).toEqual([]);
  });
});
```

The two literals (113, 25) are measured values from the Plan 1 fixtures, not guesses — see the plan's "What the Plan 1 capture established" table. If either assertion fails, the protocol changed under you: STOP and report it rather than editing the number, because every manifest claim in this plan rests on them.

- [ ] **Step 3: Run to verify it fails**

Run: `bun --bun vitest run --root host`
Expected: FAIL — no such package / cannot resolve `host/vitest.config.ts`.

- [ ] **Step 4: Write the scaffold**

`host/package.json`:
```json
{
  "name": "@traycer/open-host",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@traycer/protocol": "workspace:*"
  }
}
```

`host/src/index.ts`:
```ts
/**
 * @traycer/open-host — the fork's open-source replacement for the proprietary
 * Traycer host. Entrypoint is filled in by Task 5; this file exists so the
 * package resolves.
 */
export const OPEN_HOST_NAME = "@traycer/open-host";
```

For `tsconfig.json`, `project.json` and `vitest.config.ts`, copy the capture-proxy equivalents and change only the paths and the package name.

- [ ] **Step 5: Install and run**

Run: `bun install && bun --bun vitest run --root host`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add host/package.json host/tsconfig.json host/project.json host/vitest.config.ts host/src/index.ts host/src/__tests__/protocol-wiring.test.ts bun.lock
git commit -s -m "scaffold the open host package"
```

---

### Task 3: Store — atomic local persistence

**Files:**
- Create: `host/src/store/store.ts`
- Test: `host/src/__tests__/store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type StorePaths = { readonly dataDir: string };
  export function resolveDataDir(override: string | null): string;
  export function readJson<T>(paths: StorePaths, name: string, parse: (raw: unknown) => T): Promise<T | null>;
  export function writeJson(paths: StorePaths, name: string, value: unknown): Promise<void>;
  ```
- Consumed by: Task 4 (host identity), Tasks 8–11 (domain state).

- [ ] **Step 1: Write the failing tests**

`host/src/__tests__/store.test.ts`:
```ts
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
```

That last test is the one that matters. The spec's error-handling section requires that the host "never corrupt the store on hard kill" — serialize BEFORE touching the filesystem, so a value that cannot be stringified never truncates a good file.

- [ ] **Step 2: Run to verify they fail**

Run: `bun --bun vitest run --root host -t "store"`
Expected: FAIL — cannot resolve `../store/store`.

- [ ] **Step 3: Implement**

`host/src/store/store.ts`:
```ts
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
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun --bun vitest run --root host`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/src/store/store.ts host/src/__tests__/store.test.ts
git commit -s -m "add atomic json store for the open host"
```

---

### Task 4: Bootstrap — CLI args, host identity, and `pid.json`

**Files:**
- Create: `host/src/bootstrap/args.ts`
- Create: `host/src/bootstrap/identity.ts`
- Create: `host/src/bootstrap/pid-file.ts`
- Test: `host/src/__tests__/bootstrap.test.ts`

**Interfaces:**
- Consumes: `resolveDataDir`, `readJson`, `writeJson` (Task 3).
- Produces:
  ```ts
  export type HostArgs = {
    readonly hostDataDir: string | null;
    readonly layer0AttemptId: string | null;
    readonly layer0StatusFd: number | null;
  };
  export function parseHostArgs(argv: readonly string[]): HostArgs;

  export type HostIdentity = { readonly hostId: string };
  export function loadOrCreateIdentity(paths: StorePaths): Promise<HostIdentity>;

  export type PidMetadata = {
    readonly pid: number;
    readonly hostId: string;
    readonly version: string;
    readonly websocketUrl: string;
    readonly startedAt: string;
    readonly processStartIdentity: null;
  };
  export function writePidFile(paths: StorePaths, meta: PidMetadata): Promise<void>;
  export function removePidFile(paths: StorePaths): Promise<void>;
  ```

**Schema citations required in this task's code comments:**
- The `pid.json` field set comes from `HostPidMetadata` in `clients/shared/host-lifecycle/shared/host-process.ts:16-30`, and the decoder's required-field check is at `:103-109` — which requires **five** fields, not three: `pid` (number), `version` (string), plus `hostId`/`websocketUrl`/`startedAt` (strings).
- `HostPidMetadata` also carries `processStartTimeMs: number | null` (`:22-23`). Omitting it is safe — the type's own doc comment at `:8-15` states that records written by shipped versions lack it and that absence is `null`, "never a decode failure". Do not fabricate a value.
- `processStartIdentity` may be `null` (`:29`, and the decoder tolerates a non-matching value at `:128-129`). Plan 1 established empirically that an absent or invalid `processStartIdentity` fails **open** — the client does not reject the host for it. Write `null` and do not fabricate one.

- [ ] **Step 1: Write the failing tests**

`host/src/__tests__/bootstrap.test.ts`:
```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHostArgs } from "../bootstrap/args";
import { loadOrCreateIdentity } from "../bootstrap/identity";
import { removePidFile, writePidFile } from "../bootstrap/pid-file";

describe("parseHostArgs", () => {
  it("returns all-null for no args", () => {
    expect(parseHostArgs([])).toEqual({
      hostDataDir: null,
      layer0AttemptId: null,
      layer0StatusFd: null,
    });
  });

  it("parses the three CLI-supplied args the installer passes", () => {
    expect(
      parseHostArgs([
        "--host-data-dir",
        "/x",
        "--layer0-attempt-id",
        "abc",
        "--layer0-status-fd",
        "3",
      ]),
    ).toEqual({ hostDataDir: "/x", layer0AttemptId: "abc", layer0StatusFd: 3 });
  });

  it("tolerates unknown args instead of exiting", () => {
    expect(parseHostArgs(["--brand-new-flag", "v"]).hostDataDir).toBeNull();
  });
});

describe("identity", () => {
  it("creates a hostId and reuses it across restarts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "open-host-id-"));
    const first = await loadOrCreateIdentity({ dataDir });
    const second = await loadOrCreateIdentity({ dataDir });
    expect(first.hostId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.hostId).toBe(first.hostId);
  });
});

describe("pid file", () => {
  const meta = {
    pid: 1234,
    hostId: "h-1",
    version: "0.0.0",
    websocketUrl: "ws://127.0.0.1:5000/rpc",
    startedAt: "1970-01-01T00:00:00.000Z",
    processStartIdentity: null,
  } as const;

  it("writes every field the client decoder requires", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "open-host-pid-"));
    await writePidFile({ dataDir }, meta);
    const raw: unknown = JSON.parse(
      await readFile(join(dataDir, "pid.json"), "utf8"),
    );
    expect(raw).toEqual(meta);
  });

  it("removes the file on shutdown", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "open-host-pid-"));
    await writePidFile({ dataDir }, meta);
    await removePidFile({ dataDir });
    await expect(readFile(join(dataDir, "pid.json"), "utf8")).rejects.toThrow();
  });

  it("is a no-op when the file is already gone", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "open-host-pid-"));
    await expect(removePidFile({ dataDir })).resolves.toBeUndefined();
  });

  it("only advertises a loopback /rpc url", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "open-host-pid-"));
    await writePidFile({ dataDir }, meta);
    const text = await readFile(join(dataDir, "pid.json"), "utf8");
    expect(text).toContain("ws://127.0.0.1:");
    expect(text).toContain("/rpc");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun --bun vitest run --root host -t "pid file"`
Expected: FAIL — modules do not resolve.

- [ ] **Step 3: Implement the three modules**

`host/src/bootstrap/args.ts` — hand-roll the scan rather than using `parseArgs`, because `node:util`'s `parseArgs` throws on unknown options and the installer is free to pass flags a future host adds. Tolerating them is the requirement:
```ts
export type HostArgs = {
  readonly hostDataDir: string | null;
  readonly layer0AttemptId: string | null;
  readonly layer0StatusFd: number | null;
};

/**
 * Tolerant on purpose: `node:util`'s parseArgs throws on an unknown option,
 * and the CLI that launches a host may pass flags this build predates. An
 * unknown flag must never stop the host from booting.
 */
export function parseHostArgs(argv: readonly string[]): HostArgs {
  const read = (name: string): string | null => {
    const at = argv.indexOf(name);
    if (at === -1 || at + 1 >= argv.length) return null;
    return argv[at + 1];
  };
  const fd = read("--layer0-status-fd");
  const parsedFd = fd === null ? null : Number.parseInt(fd, 10);
  return {
    hostDataDir: read("--host-data-dir"),
    layer0AttemptId: read("--layer0-attempt-id"),
    layer0StatusFd:
      parsedFd === null || Number.isNaN(parsedFd) ? null : parsedFd,
  };
}
```

`host/src/bootstrap/identity.ts` — persist a `crypto.randomUUID()` under `identity.json` via the Task 3 store, returning the existing one when present.

`host/src/bootstrap/pid-file.ts` — `writePidFile` delegates to `writeJson(paths, "pid.json", meta)` so it inherits Task 3's atomic rename; `removePidFile` unlinks and swallows ENOENT.

- [ ] **Step 4: Run to verify they pass**

Run: `bun --bun vitest run --root host`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/src/bootstrap/args.ts host/src/bootstrap/identity.ts host/src/bootstrap/pid-file.ts host/src/__tests__/bootstrap.test.ts
git commit -s -m "add open host bootstrap args identity and pid file"
```

---

### Task 5: Loopback listener with `GET /activity` and WebSocket upgrade

**Files:**
- Create: `host/src/server/listener.ts`
- Test: `host/src/__tests__/listener.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type LegHandlers = {
    readonly onRpcMessage: (send: (text: string) => void, raw: string) => void;
    readonly onStreamMessage: (send: (text: string) => void, raw: string) => void;
  };
  export type Listener = {
    readonly port: number;
    readonly websocketUrl: string;
    stop(): Promise<void>;
  };
  export function startListener(handlers: LegHandlers): Listener;
  ```
- Consumed by: Task 6 (handshake wiring), Task 12 (stream leg).

**Schema citations required:**
- `GET /activity` must answer `{"busy": boolean}` — `clients/shared/host-client/host-activity-probe.ts:33-43`. Anything else (404, malformed body, timeout) is read as **busy**, which blocks the desktop's restart path. Return `{"busy": false}` with a JSON content type.

- [ ] **Step 1: Write the failing tests**

`host/src/__tests__/listener.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { startListener, type Listener } from "../server/listener";

const noop = (): void => {};
let listener: Listener | null = null;

afterEach(async () => {
  await listener?.stop();
  listener = null;
});

describe("listener", () => {
  it("binds an ephemeral loopback port and advertises a /rpc url", () => {
    listener = startListener({ onRpcMessage: noop, onStreamMessage: noop });
    expect(listener.port).toBeGreaterThan(0);
    expect(listener.websocketUrl).toBe(`ws://127.0.0.1:${listener.port}/rpc`);
  });

  it("answers GET /activity with a parseable busy:false", async () => {
    listener = startListener({ onRpcMessage: noop, onStreamMessage: noop });
    const response = await fetch(`http://127.0.0.1:${listener.port}/activity`);
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ busy: false });
  });

  it("routes a /rpc frame to the rpc handler only", async () => {
    const seen: string[] = [];
    listener = startListener({
      onRpcMessage: (send, raw) => {
        seen.push(`rpc:${raw}`);
        send("ack");
      },
      onStreamMessage: (send, raw) => {
        seen.push(`stream:${raw}`);
      },
    });
    const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/rpc`);
    await new Promise((r) => socket.addEventListener("open", r, { once: true }));
    const reply = new Promise<string>((r) =>
      socket.addEventListener("message", (e) => r(String(e.data)), {
        once: true,
      }),
    );
    socket.send("hello");
    expect(await reply).toBe("ack");
    expect(seen).toEqual(["rpc:hello"]);
    socket.close();
  });

  it("routes a /stream frame to the stream handler only", async () => {
    const seen: string[] = [];
    listener = startListener({
      onRpcMessage: (send, raw) => seen.push(`rpc:${raw}`),
      onStreamMessage: (send, raw) => {
        seen.push(`stream:${raw}`);
        send("ack");
      },
    });
    const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/stream`);
    await new Promise((r) => socket.addEventListener("open", r, { once: true }));
    const reply = new Promise<string>((r) =>
      socket.addEventListener("message", (e) => r(String(e.data)), {
        once: true,
      }),
    );
    socket.send("hello");
    expect(await reply).toBe("ack");
    expect(seen).toEqual(["stream:hello"]);
    socket.close();
  });

  it("rejects an unknown path", async () => {
    listener = startListener({ onRpcMessage: noop, onStreamMessage: noop });
    const response = await fetch(`http://127.0.0.1:${listener.port}/nope`);
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun --bun vitest run --root host -t "listener"`
Expected: FAIL — cannot resolve `../server/listener`.

Note the runner: `bun --bun vitest`. Under plain Node these tests fail with "Bun is not defined", which looks like a code bug and is not one.

- [ ] **Step 3: Implement with `Bun.serve`**

Bind `hostname: "127.0.0.1"` and `port: 0` (kernel-assigned). Store the leg on the socket's `data` at upgrade time so `message` can dispatch without re-parsing the URL. `stop()` must call `server.stop(true)`.

Bind to `127.0.0.1` explicitly, never `0.0.0.0`: the client rejects any URL that is not loopback, and binding wider would expose an unauthenticated RPC surface to the network.

- [ ] **Step 4: Run to verify they pass**

Run: `bun --bun vitest run --root host`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/src/server/listener.ts host/src/__tests__/listener.test.ts
git commit -s -m "add loopback listener with activity probe and leg routing"
```

---

### Task 6: RPC handshake — `open` → `openAck`

**Files:**
- Create: `host/src/handshake/rpc-handshake.ts`
- Test: `host/src/__tests__/rpc-handshake.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type HandshakeOutcome =
    | { readonly kind: "openAck"; readonly frame: HostOpenAckFrame }
    | { readonly kind: "fatalError"; readonly frame: HostFatalErrorFrame };
  export function buildHostManifest(): SplitConnectionManifest;
  export function handleOpenFrame(raw: unknown): HandshakeOutcome;
  ```
- Consumed by: Task 7 (dispatcher).

**Schema citations required:**
- `open` frame shape: `clientOpenFrameSchema`, `protocol/src/framework/ws-protocol.ts:232`.
- `openAck` frame shape: `hostOpenAckFrameSchema`, `protocol/src/framework/ws-protocol.ts:266`. The capture confirms the wire payload is exactly `{kind, manifest, optionalManifest}` — no version or hostId field.
- Compatibility oracle: `check(...)` in `protocol/src/framework/compatibility-checker.ts:42`, called with `selfRole: "host"`.
- The union rule that forces the full floor: `collectManifestMethods` in `protocol/src/framework/compat-helpers.ts:64-76` takes the **union** of both required manifests, and a method present in one but absent from the other is `INCOMPATIBLE`. The client's required manifest is fixed at the 113 `RELEASED_FLOOR_METHOD_NAMES` (`clients/shared/host-transport/ws-rpc-client.ts:430`). Therefore the host MUST advertise all 113.
- The client compares **required manifests only**, not merged ones: `ws-rpc-client.ts:360-365` passes `clientManifest.manifest` and `ackFrame.manifest`. Methods absent from the host's merged manifest take `executeUnavailableMethodDegrade` (`ws-rpc-client.ts:395-408`) — a graceful degrade, not a fatal. This is why `optionalManifest` may ship empty.

- [ ] **Step 1: Write the failing tests**

The decisive test replays the **real recorded client `open` frame** from the Plan 1 fixture. That is the difference between checking this code against the plan and checking it against the wire.

`host/src/__tests__/rpc-handshake.test.ts`:
```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHostManifest, handleOpenFrame } from "../handshake/rpc-handshake";

const FIXTURE = join(
  __dirname,
  "..",
  "..",
  "..",
  "tools",
  "capture-proxy",
  "fixtures",
  "boot.scrubbed.jsonl",
);

type Recorded = {
  readonly leg: string;
  readonly kind: string;
  readonly payload: unknown;
};

async function recordedFrames(kind: string): Promise<unknown[]> {
  const text = await readFile(FIXTURE, "utf8");
  const out: unknown[] = [];
  for (const line of text.trim().split("\n")) {
    const frame = JSON.parse(line) as Recorded;
    if (frame.leg === "rpc" && frame.kind === kind) out.push(frame.payload);
  }
  return out;
}

describe("rpc handshake", () => {
  it("advertises exactly the 113-method floor as required", () => {
    const { manifest } = buildHostManifest();
    expect(Object.keys(manifest)).toHaveLength(113);
  });

  it("advertises no optional methods in this milestone", () => {
    expect(Object.keys(buildHostManifest().optionalManifest)).toEqual([]);
  });

  it("accepts every real recorded client open frame", async () => {
    const opens = await recordedFrames("open");
    expect(opens.length).toBeGreaterThan(0);
    for (const open of opens) {
      expect(handleOpenFrame(open).kind).toBe("openAck");
    }
  });

  it("advertises the same required method NAMES the real host did", async () => {
    const [recordedAck] = (await recordedFrames("openAck")) as [
      { readonly manifest: Record<string, unknown> },
    ];
    const ours = Object.keys(buildHostManifest().manifest).sort();
    expect(ours).toEqual(Object.keys(recordedAck.manifest).sort());
  });

  it("rejects a client that is missing a floor method", () => {
    const { manifest } = buildHostManifest();
    const truncated = { ...manifest };
    delete truncated["host.status"];
    const outcome = handleOpenFrame({
      kind: "open",
      token: "ignored",
      manifest: truncated,
      optionalManifest: {},
    });
    expect(outcome.kind).toBe("fatalError");
    if (outcome.kind !== "fatalError") throw new Error("unreachable");
    expect(outcome.frame.details.code).toBe("INCOMPATIBLE");
  });

  it("rejects a structurally invalid open frame", () => {
    expect(handleOpenFrame({ kind: "open" }).kind).toBe("fatalError");
  });
});
```

The fourth test is the one that would have caught Plan 1's whole class of defects: it compares our manifest against what a **real host actually sent**, not against a number in a document.

- [ ] **Step 2: Run to verify they fail**

Run: `bun --bun vitest run --root host -t "rpc handshake"`
Expected: FAIL — cannot resolve `../handshake/rpc-handshake`.

- [ ] **Step 3: Implement**

`host/src/handshake/rpc-handshake.ts`:
```ts
import { splitConnectionManifest } from "@traycer/protocol/framework/capability-manifest";
import { check } from "@traycer/protocol/framework/compatibility-checker";
import { clientOpenFrameSchema } from "@traycer/protocol/framework/ws-protocol";
import { hostRpcRegistry } from "@traycer/protocol/host";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

/**
 * Built from the SAME registry + floor constant the client uses
 * (`clients/shared/host-transport/ws-rpc-client.ts:430`), so the required
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
```

`handleOpenFrame` parses with `clientOpenFrameSchema.safeParse`, returns a `fatalError` frame with a `PROTOCOL_ERROR`-shaped detail on a parse failure, then runs `check(hostRpcRegistry, ours.manifest, parsed.manifest, "host")` and returns either the `openAck` or the checker's own `details` verbatim.

The bearer token is read and discarded. Do not verify it, do not log it — it is a live cloud credential.

- [ ] **Step 4: Run to verify they pass**

Run: `bun --bun vitest run --root host`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/src/handshake/rpc-handshake.ts host/src/__tests__/rpc-handshake.test.ts
git commit -s -m "add rpc handshake with registry derived manifest"
```

---

### Task 7: RPC dispatcher, method table, and the host entrypoint

**Files:**
- Create: `host/src/rpc/contracts.ts`
- Create: `host/src/rpc/dispatcher.ts`
- Create: `host/src/rpc/method-table.ts`
- Create: `host/src/main.ts`
- Test: `host/src/__tests__/dispatcher.test.ts`

**Interfaces:**
- Consumes: `handleOpenFrame` (Task 6), `startListener` (Task 5), bootstrap (Task 4).
- Produces:
  ```ts
  export type MethodHandler = (params: unknown) => Promise<unknown>;
  export type MethodTable = ReadonlyMap<string, MethodHandler>;
  export function contractFor(method: string, version: SchemaVersion): AnyRpcContract | null;
  export function createDispatcher(table: MethodTable): (raw: string) => Promise<string | null>;
  ```
- Consumed by: Tasks 8–11, each of which adds entries to the method table.

**Schema citations required:**
- Request frame: `clientRequestFrameSchema`, `protocol/src/framework/ws-protocol.ts:240`.
- Response frame: `hostResponseFrameSchema`, `protocol/src/framework/ws-protocol.ts:284`; error payload `hostResponseErrorSchema` at `:278`. The capture confirms the wire shape is `{kind, requestId, method, schemaVersion, result, error}` with `error: null` on success.
- Error codes are a closed set: `RPC_ERROR_CODES`, `protocol/src/framework/versioned-rpc-types.ts:14`. Use `"RPC_ERROR"` for an unimplemented method — `E_HOST_UNSUPPORTED` exists but signals a deliberate capability gap the GUI may render differently, and an unimplemented method is a backlog item, not a capability statement.
- Contract lookup: the registry nests as `registry[method][major].versions[minor]` — read off `getMajorLine` in `protocol/src/framework/compatibility-checker.ts:150-166`. Each contract carries `requestSchema` / `responseSchema` (`versioned-rpc-types.ts:69-77`).

- [ ] **Step 1: Write the failing tests**

`host/src/__tests__/dispatcher.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { createDispatcher, type MethodTable } from "../rpc/dispatcher";

const REQUEST = JSON.stringify({
  kind: "request",
  requestId: "r-1",
  method: "host.status",
  schemaVersion: { major: 1, minor: 1 },
  params: {},
});

describe("dispatcher", () => {
  it("routes to a handler and wraps the result in a response frame", async () => {
    const table: MethodTable = new Map([
      ["host.status", async () => ({ ready: true })],
    ]);
    const raw = await createDispatcher(table)(REQUEST);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({
      kind: "response",
      requestId: "r-1",
      method: "host.status",
      schemaVersion: { major: 1, minor: 1 },
      result: { ready: true },
      error: null,
    });
  });

  it("returns a well-formed error for an unimplemented method", async () => {
    const raw = await createDispatcher(new Map())(REQUEST);
    const frame = JSON.parse(raw as string) as {
      readonly result: unknown;
      readonly error: { readonly code: string; readonly message: string };
    };
    expect(frame.result).toBeNull();
    expect(frame.error.code).toBe("RPC_ERROR");
    expect(frame.error.message).toContain("host.status");
  });

  it("logs an unimplemented method loudly - the log is the backlog", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await createDispatcher(new Map())(REQUEST);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("host.status");
    warn.mockRestore();
  });

  it("converts a throwing handler into an error frame, never a crash", async () => {
    const table: MethodTable = new Map([
      [
        "host.status",
        async () => {
          throw new Error("boom");
        },
      ],
    ]);
    const frame = JSON.parse(
      (await createDispatcher(table)(REQUEST)) as string,
    ) as { readonly error: { readonly message: string } };
    expect(frame.error.message).toContain("boom");
  });

  it("drops an unparseable frame without replying and without throwing", async () => {
    await expect(createDispatcher(new Map())("{not json")).resolves.toBeNull();
  });

  it("drops a structurally invalid frame without replying", async () => {
    await expect(
      createDispatcher(new Map())(JSON.stringify({ kind: "request" })),
    ).resolves.toBeNull();
  });

  it("echoes the requested schemaVersion back, not the canonical one", async () => {
    const table: MethodTable = new Map([["host.status", async () => ({})]]);
    const older = JSON.stringify({
      kind: "request",
      requestId: "r-2",
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      params: {},
    });
    const frame = JSON.parse((await createDispatcher(table)(older)) as string) as {
      readonly schemaVersion: unknown;
    };
    expect(frame.schemaVersion).toEqual({ major: 1, minor: 0 });
  });
});
```

The last test encodes a real protocol requirement: the response echoes the version the caller asked for. The capture shows the client requesting `worktree.listAllForHost` at `1.4` while the repo's canonical is `1.5`, and answering at a different version than asked is a silent contract break.

- [ ] **Step 2: Run to verify they fail**

Run: `bun --bun vitest run --root host -t "dispatcher"`
Expected: FAIL — cannot resolve `../rpc/dispatcher`.

- [ ] **Step 3: Implement the dispatcher**

Parse with `clientRequestFrameSchema.safeParse`; on failure return `null` (drop and log, never tear down the connection for one bad frame — spec's error-handling rule). On an unknown method, `console.warn` one line carrying method and version, and return an `RPC_ERROR` response frame. Wrap every handler call in try/catch and convert a thrown error into an error frame.

- [ ] **Step 4: Write `main.ts`, the entrypoint**

Wire it together in this order, because the order is load-bearing: bind the listener FIRST, then write `pid.json` with the real port. `pid.json` is the client's only discovery channel, so publishing it before the port is live advertises an endpoint that refuses connections.

```ts
async function main(): Promise<void> {
  const args = parseHostArgs(Bun.argv.slice(2));
  const paths = { dataDir: resolveDataDir(args.hostDataDir) };
  const identity = await loadOrCreateIdentity(paths);
  const listener = startListener({ ... });
  await writePidFile(paths, {
    pid: process.pid,
    hostId: identity.hostId,
    version: OPEN_HOST_VERSION,
    websocketUrl: listener.websocketUrl,
    startedAt: new Date().toISOString(),
    processStartIdentity: null,
  });
  const shutdown = async (): Promise<void> => {
    await removePidFile(paths);
    await listener.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
```

Removing `pid.json` must be the FIRST thing shutdown does and must run even if `listener.stop()` throws — a stale `pid.json` pointing at a dead port is the single worst failure mode for the client, which is exactly the lesson Plan 1's proxy restore ordering encoded.

- [ ] **Step 5: Write the entrypoint subprocess test**

Add to `host/src/__tests__/` a subprocess test in the shape of Task 1's: spawn `host/src/main.ts` with `--host-data-dir <temp>`, poll for `pid.json`, assert its `websocketUrl` answers `GET /activity` with `{busy:false}`, then `SIGTERM` and assert `pid.json` is gone. This is the carried-forward Plan 1 rule applied at the point it was aimed at — entrypoints get subprocess coverage from the start here.

- [ ] **Step 6: Run the suite**

Run: `bun --bun vitest run --root host`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add host/src/rpc/contracts.ts host/src/rpc/dispatcher.ts host/src/rpc/method-table.ts host/src/main.ts host/src/__tests__/dispatcher.test.ts host/src/__tests__/main-subprocess.test.ts
git commit -s -m "add rpc dispatcher and open host entrypoint"
```

---

## How to implement a domain method (Tasks 8–11 all follow this)

Do not guess a response shape. For every method, in this order:

1. **Find the contract.** `rg '"<method>"' protocol/src/host/registry.ts` gives the registration; follow it to the contract module that declares `responseSchema`. Cite that file and line in a comment above the handler.
2. **Look at what a real host answered.** The Plan 1 fixtures hold genuine responses:
   ```sh
   jq -c 'select(.leg=="rpc" and .kind=="response" and .method=="<method>") | .payload.result' \
     tools/capture-proxy/fixtures/boot.scrubbed.jsonl | head -2
   ```
   Use it as a reference for realistic values and for which optional fields a real host populates. Remember the captured host is OLDER than this repo on 14 methods, so its shape may legitimately differ from the canonical contract — the contract wins, the capture informs.
3. **Write the handler to return the minimum truthful answer.** For this milestone that usually means an empty collection or a locally-derived fact. Never invent cloud state: no fake subscriptions, no fake rate limits, no fake collaborators.
4. **Assert against the contract, not against your own expectation:**
   ```ts
   const contract = contractFor(method, canonicalVersion);
   expect(() => contract.responseSchema.parse(await handler({}))).not.toThrow();
   ```
   This single assertion is what makes a domain task trustworthy — it checks the code against `protocol/src`, which is the failure mode that cost Plan 1 four defects.

If a contract demands a field the host genuinely cannot know locally, STOP and report it rather than inventing a plausible value — that is a design question about what "open host" means, and it belongs with the human, not in a handler.

---

### Task 8: Domain tier A — `host.*`

**Files:**
- Create: `host/src/domain/host-status.ts`
- Modify: `host/src/rpc/method-table.ts`
- Test: `host/src/__tests__/domain-host.test.ts`

**Methods:** `host.status`, `host.getRuntimeCapabilities`, `host.identity.get`, `host.getRateLimitUsage`.

**Interfaces:**
- Consumes: `contractFor` (Task 7), `HostIdentity` (Task 4).
- Produces: `export function registerHostMethods(table: Map<string, MethodHandler>, identity: HostIdentity): void`.

- [ ] **Step 1: Read the contracts and the recorded responses**

`host.status` is the anchor. The capture recorded a real answer:
```json
{"ready":true,"hostVersion":"1.1.11","protocolVersion":{"major":1,"minor":0}}
```
Report the open host's own version, not `1.1.11`.

`host.getRateLimitUsage` is the interesting one: rate-limit metering is explicitly out of scope (spec, "Explicitly out of scope"). Read its contract and return the shape that means "nothing metered". If the contract cannot express that, report it rather than fabricating usage numbers.

- [ ] **Step 2: Write the failing tests**

For each of the four methods, assert (a) the handler's result parses against `contract.responseSchema`, and (b) the specific facts that matter: `host.status.ready === true`, and `host.identity.get` returns the same `hostId` that `pid.json` advertises. A host whose `pid.json` and `identity.get` disagree is one the client cannot bind to a tab.

- [ ] **Step 3: Run to verify they fail, implement, run to verify they pass**

Run: `bun --bun vitest run --root host -t "domain host"`

- [ ] **Step 4: Commit**

```bash
git add host/src/domain/host-status.ts host/src/rpc/method-table.ts host/src/__tests__/domain-host.test.ts
git commit -s -m "implement host status identity and capability methods"
```

---

### Task 9: Domain tier B — `worktree.*` and `workspace.*`

**Files:**
- Create: `host/src/domain/worktree.ts`
- Modify: `host/src/rpc/method-table.ts`
- Test: `host/src/__tests__/domain-worktree.test.ts`

**Methods:** `worktree.listAllForHost`, `worktree.listByWorkspacePaths`, `worktree.getBinding`, `worktree.listBindingsForEpic`, `workspace.resolvePathsByRepoIdentifiers`.

These five are the boot tier's heaviest lifting: `worktree.listAllForHost` is the **first** method the GUI calls after the handshake (capture, boot frame 5), so if it errors the app's first impression of the host is a failure.

- [ ] **Step 1: Read contracts and recorded responses**

Follow the domain-method procedure above for each. Note the version gap: the capture shows the client negotiating `worktree.listAllForHost` at `1.4` against the old host while this repo's canonical is `1.5`. Implement the canonical version; the dispatcher echoes whatever version was requested.

- [ ] **Step 2: Decide the honest empty answer**

For this milestone the open host manages no worktrees, so every one of these returns an empty collection. Write that intent in a comment: it is a deliberate "nothing yet", not an unimplemented stub, and a later milestone fills it in.

- [ ] **Step 3: Write failing tests, implement, verify**

Every handler's result must parse against its `responseSchema`. Add one test asserting the empty-collection answers are *structurally* empty (e.g. `result.worktrees` is `[]`), so a later real implementation cannot silently regress to a shape the GUI reads as "one unnamed worktree".

Run: `bun --bun vitest run --root host -t "domain worktree"`

- [ ] **Step 4: Commit**

```bash
git add host/src/domain/worktree.ts host/src/rpc/method-table.ts host/src/__tests__/domain-worktree.test.ts
git commit -s -m "implement worktree and workspace boot reads"
```

---

### Task 10: Domain tier C — `providers.*`, `agent.gui.*`, `agent.selectionGuide.*`, `speech.*`

**Files:**
- Create: `host/src/domain/providers.ts`
- Create: `host/src/domain/agent-gui.ts`
- Modify: `host/src/rpc/method-table.ts`
- Test: `host/src/__tests__/domain-providers.test.ts`
- Test: `host/src/__tests__/domain-agent-gui.test.ts`

**Methods:** `providers.list`, `providers.setEnabled`, `speech.getModelStatus`, `agent.gui.listHarnesses`, `agent.gui.listModels`, `agent.gui.listCommands`, `agent.selectionGuide.getGlobalOnboardingDraft`, `agent.selectionGuide.setGlobal`.

This is the tier that decides whether the fork's central promise — **works with any model** — has a foothold. `providers.list` is the most-called method in the entire capture (39 calls).

- [ ] **Step 1: Read `providers.list`'s contract carefully**

It is version 8 in this repo and the richest response in the boot tier. Two fields are secret-adjacent and Plan 1 documented both:
- `token: { vars: string[] }` is a list of credential ENV VAR **names**, not a credential (`protocol/src/host/provider-schemas.ts:933,991,1018,1043`).
- `apiKey: { supported, configured, source }` is key **state**, not a key (`provider-schemas.ts:893-897`).

Populate both as state only. The open host must never place a credential value in a `providers.list` response.

- [ ] **Step 2: Decide what a provider list means with no cloud**

Report locally-detectable providers only. A provider is "configured" when its env var is present in the host's environment; never read, log, or return the value. `providers.setEnabled` persists a boolean through the Task 3 store.

- [ ] **Step 3: `agent.gui.listHarnesses` — report Claude Code only**

Plan 3 builds the harness; this task reports it as available-but-unstarted if the contract allows, and otherwise reports an empty list. Do not report harnesses the host cannot run.

- [ ] **Step 4: Write failing tests, implement, verify**

Beyond the `responseSchema` assertions, add one security test: given an environment containing `ANTHROPIC_API_KEY=sk-ant-test-value`, the JSON-serialized `providers.list` response must NOT contain the substring `sk-ant-test-value`. Plan 1's hardest-won lesson is that a rule nobody wrote is a rule nothing enforces; this writes it.

Run: `bun --bun vitest run --root host -t "domain providers"`

- [ ] **Step 5: Commit**

```bash
git add host/src/domain/providers.ts host/src/domain/agent-gui.ts host/src/rpc/method-table.ts host/src/__tests__/domain-providers.test.ts host/src/__tests__/domain-agent-gui.test.ts
git commit -s -m "implement provider and agent selection boot reads"
```

---

### Task 11: Domain tier D — `epic.*` reads and `terminal.list`

**Files:**
- Create: `host/src/domain/epic.ts`
- Modify: `host/src/rpc/method-table.ts`
- Test: `host/src/__tests__/domain-epic.test.ts`

**Methods:** `epic.listTasks`, `epic.listCollaborators`, `epic.listCommentThreads`, `terminal.list`.

- [ ] **Step 1: Note what these mean without a cloud**

`epic.listCollaborators` and `epic.listCommentThreads` are collaboration surfaces, explicitly out of scope. They return empty and always will in this fork — say so in a comment so a later reader does not file them as unfinished work.

`epic.listTasks` returns the local task list, which is empty until Plan 3 creates one, but it is the method whose *shape* the main UI renders from. Read its contract with care.

- [ ] **Step 2: Write failing tests, implement, verify**

Run: `bun --bun vitest run --root host -t "domain epic"`

- [ ] **Step 3: Commit**

```bash
git add host/src/domain/epic.ts host/src/rpc/method-table.ts host/src/__tests__/domain-epic.test.ts
git commit -s -m "implement epic and terminal boot reads"
```

---

### Task 12: Stream leg — handshake, subscribe routing, keepalive

**Files:**
- Create: `host/src/stream/stream-handshake.ts`
- Create: `host/src/stream/stream-server.ts`
- Modify: `host/src/main.ts`
- Test: `host/src/__tests__/stream.test.ts`

**Interfaces:**
- Produces: `export function handleStreamOpen(raw: unknown): StreamHandshakeOutcome;` and a per-connection `StreamSession` that routes `subscribe` frames and answers `ping`.

**Schema citations required:**
- `open`: `clientStreamOpenFrameSchema`, `protocol/src/framework/stream-ws-protocol.ts:192` — `{kind, token, manifest}`. Note it carries **no** `optionalManifest`; the stream leg has no floor split.
- `openAck`: `hostStreamOpenAckFrameSchema`, `stream-ws-protocol.ts:228` — `{kind, manifest, capabilities, hostCredentialState}`.
- `subscribe`: `clientStreamSubscribeFrameSchema`, `stream-ws-protocol.ts:198`.
- Manifest construction: `buildStreamManifest(hostStreamRpcRegistry)`, `protocol/src/framework/stream-compat.ts` — the **full** registry, no floor split, so all 25 stream methods are advertised.
- Compatibility: `checkStreamCompatibility(..., "host")`, same file. It has no cross-major bridging — stream clients reconnect on a mismatched major instead.

- [ ] **Step 1: `hostCredentialState` MUST be `null`**

`stream-ws-protocol.ts:234-238` documents `null` as "did not report", which the client treats as **do not provision**. That single field is what keeps the open host out of the credential-provisioning flow entirely — the flow that carries a raw `refreshToken` c2h (`clientStreamHostCredentialProvisionFrameSchema`, `stream-ws-protocol.ts:210-218`). An open host has no cloud to provision against and must never solicit that credential.

Write a test asserting the emitted `openAck` has `hostCredentialState: null`, and a comment explaining why. This is a security property, not a default.

- [ ] **Step 2: Answer the two subscriptions boot actually makes**

The capture shows exactly two at boot: `worktree.changed` v1.0 (answered with a `changed` frame) and `resources.subscribe` v1.3 (answered with a `snapshot`, then `update` frames). Implement those two; every other subscribe gets a logged, well-formed rejection.

- [ ] **Step 3: Implement ping/pong keepalive**

The capture shows 178 `ping` and 178 `pong` frames in **each** direction — the host both sends pings and answers them. A stream that stops answering pings is dropped by the client, so this is not optional decoration.

- [ ] **Step 4: Do not send binary frames**

The envelope carries `hasBinaryPayload: boolean` (`stream-ws-protocol.ts:255-260`). This milestone's streams have no binary payloads: always emit `hasBinaryPayload: false` and never follow a text envelope with a binary frame. Plan 3 owns the binary/CRDT path and it is a design question, not an implementation detail.

- [ ] **Step 5: Write failing tests, implement, verify**

Replay the recorded stream `open` frames from `boot.scrubbed.jsonl` (`leg == "stream" && kind == "open"`) and assert each produces an `openAck`, exactly as Task 6 does for the rpc leg.

Run: `bun --bun vitest run --root host -t "stream"`

- [ ] **Step 6: Commit**

```bash
git add host/src/stream/stream-handshake.ts host/src/stream/stream-server.ts host/src/main.ts host/src/__tests__/stream.test.ts
git commit -s -m "add stream leg handshake subscribe routing and keepalive"
```

---

### Task 13: Replay conformance harness

**Files:**
- Create: `host/src/__tests__/replay.test.ts`

**Interfaces:**
- Consumes: everything. This task adds no production code — it is the plan's acceptance gate in test form.

This is the spec's "Replay tests (primary)": feed the recorded client frames into the open host and assert every answer is schema-valid. It proves "boot works" without launching Electron.

- [ ] **Step 1: Write the harness**

Read `tools/capture-proxy/fixtures/boot.scrubbed.jsonl`. For every recorded `leg=="rpc" && direction=="c2h"` frame in order, feed the payload to the real dispatcher and collect the answer. Then assert:

1. The `open` frame produces an `openAck` (not a `fatalError`).
2. Every `request` frame produces a response frame that parses against `hostResponseFrameSchema`.
3. For every method in the implemented method table, `error` is `null`.
4. **Report, do not fail, the unimplemented ones.** Print one line per distinct method that returned `RPC_ERROR`, with its call count. That list is the milestone backlog, measured rather than guessed.

- [ ] **Step 2: Assert the boot-critical set specifically**

Add an explicit assertion that these 20 floor methods answer without error, since these are what the capture proves the GUI calls:

```
agent.gui.listCommands, agent.gui.listHarnesses, agent.gui.listModels,
agent.selectionGuide.getGlobalOnboardingDraft, agent.selectionGuide.setGlobal,
epic.createChat, epic.listCollaborators, epic.listCommentThreads, epic.listTasks,
host.getRateLimitUsage, host.status, providers.list, providers.setEnabled,
speech.getModelStatus, terminal.list, workspace.resolvePathsByRepoIdentifiers,
worktree.getBinding, worktree.listAllForHost, worktree.listBindingsForEpic,
worktree.listByWorkspacePaths
```

`epic.createChat` belongs to Plan 3 and is expected to fail here. Assert the other 19 pass and record `epic.createChat` as a known-open item, so this test documents the Plan 2/3 boundary instead of blurring it.

- [ ] **Step 3: Run it**

Run: `bun --bun vitest run --root host -t "replay"`
Expected: PASS, with a printed backlog list.

- [ ] **Step 4: Commit**

```bash
git add host/src/__tests__/replay.test.ts
git commit -s -m "add replay conformance harness over capture fixtures"
```

---

### Task 14: `TRAYCER_LOCAL_MODE` client auth patch

**Files:**
- Modify: `clients/shared/auth/` (the bearer source and the three cloud calls)
- Modify: `clients/gui-app/src/` (the `authStatus` gate)
- Test: alongside each modified module

This is the **only** task in the plan that touches client code, and the plan's highest-risk task: it must stay small enough that merges from upstream stay cheap.

**Verified facts (each confirmed against source, per the standing rule):**
- `WsRpcClient` throws before dialing without a bearer — `extractBearerOrThrowRpcError`, `clients/shared/host-transport/ws-rpc-client.ts:291`.
- The GUI gates on `authStatus === "signed-in"` in several providers, e.g. `clients/gui-app/src/providers/epic-tab-existence-reconciler.tsx:98`.
- Startup reaches three cloud endpoints: `GET /api/v3/user` and `POST /api/v3/auth/refresh` (`clients/shared/auth/auth-validation.ts:230,306`) and `GET /api/v3/hosts` (`clients/desktop/src/electron-main/ipc/auth-ipc.ts:148`).

- [ ] **Step 1: Map the real surface before changing anything**

Do not trust the three bullets above as complete — they are confirmed to exist, not confirmed to be sufficient. Trace what the app touches between launch and rendered main window, and write the list into your report BEFORE editing. If the surface is materially larger than three call sites, STOP and report: that changes the shape of this task and is the human's call.

- [ ] **Step 2: Gate everything behind one flag read in one place**

Add a single module exporting `export function isLocalMode(): boolean` reading `TRAYCER_LOCAL_MODE`. Every patched site calls it. One flag, one module, no scattered `process.env` reads — that is what keeps the upstream merge cheap.

- [ ] **Step 3: Inject a static bearer and a synthetic user**

In local mode: the bearer source returns a fixed non-empty string, and the three cloud calls return synthetic success without network access. The synthetic user must be obviously synthetic (e.g. `local@localhost`) — never a plausible real identity.

- [ ] **Step 4: Leave the sign-in UI intact**

The spec is explicit: bypass, do not remove. A patch that deletes the sign-in path is a merge conflict with every upstream auth change.

- [ ] **Step 5: Test both directions**

The critical test is that the flag is **off** by default: with `TRAYCER_LOCAL_MODE` unset, every patched site behaves exactly as before. A local-mode patch that leaks into normal operation would fake a signed-in user against the real cloud.

- [ ] **Step 6: Commit**

```bash
git commit -s -m "add flag gated local mode auth bypass"
```

---

### Task 15: `make dev-open`

**Files:**
- Modify: `Makefile`
- Create: `scripts/dev-open.ts` (or the repo's existing dev-script convention — check how `dev-desktop` is implemented first)

- [ ] **Step 1: Read how `dev-desktop` works end to end**

`Makefile:31-32` delegates to `bun run dev-desktop`. Read that script. `make dev-open` is its sibling: same desktop launch, different host.

- [ ] **Step 2: Stage the host as an installable directory**

The surviving unsigned side-load path is `traycer host install --from <dir> --allow-self-invocation` (`clients/traycer-cli/src/index.ts:598-651`) — sha256 only, no signature check. Stage a directory containing an executable named `traycer-host` that launches `host/src/main.ts`.

- [ ] **Step 3: Use an isolated slot and set the flag**

Install into a dev slot, exactly as `dev-desktop` does, so the open host never disturbs a working production install. Launch the desktop with `TRAYCER_LOCAL_MODE` set.

- [ ] **Step 4: Verify the target starts the host and writes `pid.json`**

Do not attempt the full GUI walk here — that is Task 16, and it needs a human at the screen. Verify only that `make dev-open` produces a running host with a valid `pid.json` and a responding `/activity`.

- [ ] **Step 5: Commit**

```bash
git commit -s -m "add make dev-open target"
```

---

### Task 16: Manual acceptance — the app renders (OPERATOR TASK)

**This is not an agent task.** Like Plan 1's Task 9, a human runs it. Its findings decide whether Plan 2 is done.

- [ ] **Step 1: Run it**

```bash
make dev-open
```

- [ ] **Step 2: Observe against the deliverable**

Plan 2's deliverable is: the desktop app opens, connects to the open host, and the main UI renders with no agent. Record for each:
- Did the handshake complete, or did the app hard-fatal `INCOMPATIBLE`?
- Did the main window render, or did it stop at the sign-in screen?
- Which methods appear in the host's unimplemented-method log? That log is the measured backlog for Plan 3.
- Did any stream connection drop?

- [ ] **Step 3: Capture the backlog log verbatim into the ledger**

The point of the loud log is that it turns "what's left" from a guess into a list. Paste it into the SDD ledger.

- [ ] **Step 4: If the app does NOT render**

Do not patch blindly. The capture proxy from Plan 1 still works and can now sit in front of the **open** host: run it, reproduce, and diff the open host's frames against the recorded real-host frames for the same call. That comparison is what Plan 1 was built to make possible.

---

## Deferred to Plan 3 (recorded here so it is not lost)

- **`epic.createChat` and the whole conversation path.** Plan 1's capture established that agent chat is NOT request/response RPC: across 3,445 frames there is no `agent.create` and no `agent.sendMessage`. Conversation is CRDT document mutation over the stream leg (684 `update`, 96 `blockDelta`, plus `awareness` and 217 binary frames). Plan 3 as originally scoped — "agent lifecycle RPCs + chat.subscribe/terminal.subscribe" — is the wrong shape and must be re-designed around a CRDT document model before it is written.
- **Binary frame content.** The fixtures record that a conversation happened, not what it said (metadata only: `kind`, `byteLength`). Plan 3 must decide between keeping metadata-only, recording content and accepting unscrubbable bytes, or decoding the CRDT payload so it becomes scrubbable. This is a design decision with a secrets story attached, not an implementation detail.
- **The 2 optional methods** the GUI calls and this plan lets degrade: `epic.getTaskContexts`, `host.notifications.indicatorState`.

## Self-review notes

- **Spec coverage:** every component the spec's sequencing item 2 names is covered — scaffold (T2), `pid.json`/`/activity` bootstrap (T4, T5), JSON WebSocket server (T5, T7, T12), handshake with the full floor (T6), the `TRAYCER_LOCAL_MODE` patch (T14), and the status/config/workspace/identity tier (T8–T11). `make dev-open` is T15 and the acceptance walk is T16.
- **Deviation from the spec, deliberate:** the spec called for "floor-stub layer (valid-shaped, minimal responses generated from the registry contracts) for **all** floor methods". This plan implements 19 and returns well-formed errors for the other 94, because the capture proves only 22 methods are ever called and the spec's own error-handling section already designs for the unimplemented case ("well-formed protocol error + one-line backlog log"). Generating valid responses for 94 uncalled methods from zod schemas is substantial work with no observable effect on the deliverable. If Task 16 shows the GUI failing on an unimplemented method, that method gets implemented — measured, not guessed.
- **Carried-forward Plan 1 debt** is closed in T1, and its standing rule is a Global Constraint with per-task schema citations.
