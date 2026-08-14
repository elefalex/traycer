---
project: traycer
type: plan
status: active
date: 2026-08-14
title: Open Host — Plan 1 (Capture Harness)
summary: Build a loopback WebSocket recording proxy that interposes between the Traycer clients and the real signed host, producing scrubbed JSONL fixtures of the boot and task-creation RPC flows.
---

# Open Host — Plan 1 (Capture Harness) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dev-only recording proxy that sits on loopback between the Traycer desktop/GUI and the real signed host, capturing every JSON RPC/stream frame of two scripted sessions (cold boot, task flow) into scrubbed JSONL fixtures that Plans 2 and 3 replay against the open host.

**Architecture:** The proxy impersonates host *discovery* — it writes a `pid.json` naming its own live pid and a loopback `ws://127.0.0.1:<port>/rpc` URL (omitting `processStartIdentity`, which the desktop treats as "cannot compare" = fail-open), and serves `GET /activity`. For each client WebSocket it accepts on `/rpc` (one socket per unary request) or `/stream` (long-lived), it opens a matching upstream socket to the real host and pipes frames both ways, appending each to a JSONL recording. Frames on the local leg are plain UTF-8 JSON discriminated by `kind`, so recording is `JSON.parse` + schema-validate, no binary mux. A separate scrub pass redacts bearer tokens and home paths before a recording becomes a committed fixture.

**Tech Stack:** Bun 1.3.12 (native `Bun.serve` WebSocket server + global `WebSocket` client), TypeScript (ESM, `type: module`), Zod (via `catalog:`), Vitest, `@traycer/protocol` resolved from source.

## Global Constraints

- **Runtime/toolchain:** Bun `1.3.12` (pinned by root `packageManager`); Node 24. Never run `tsc` directly — use `bun run compile`.
- **Workspaces:** root `package.json` `workspaces` is `["protocol","clients/*"]`; adding `"tools/*"` is the only permitted edit to that array (additive, merge-safe).
- **Type safety (ESLint, do not bypass):** no optional params (`x?: T` → `x: T | undefined`), no default params, no `as any` / `as unknown` / chained casts, no `ReturnType<typeof fn>` — name concrete types. `catch` binds `unknown`.
- **Package identity:** new package name `@traycer-tools/capture-proxy`, `"license": "MIT"`, `"private": true`, `"type": "module"`. Scripts mirror `clients/shared`: `compile`/`lint`/`format`/`test`.
- **Commits:** DCO sign-off required — every commit uses `git commit -s`. Imperative, lowercase, no trailing period.
- **Secrets:** never commit raw recordings, bearer tokens, or `.env`. Raw recordings and scrubbed-but-unreviewed fixtures live under a gitignored directory; only a deliberately reviewed, scrubbed fixture is committed.
- **Protocol imports:** always from `@traycer/protocol/...` source paths (e.g. `@traycer/protocol/framework/ws-protocol`), never relative into `protocol/src`.

## File Structure

```
tools/capture-proxy/
├── package.json                     @traycer-tools/capture-proxy
├── tsconfig.json                    extends repo base, references protocol
├── vitest.config.ts                 node env, run mode
├── .gitignore                       recordings/  (raw + unreviewed)
├── README.md                        capture runbook (manual E2E steps)
├── src/
│   ├── recorder.ts                  append-only JSONL writer (pure I/O)
│   ├── frame-classifier.ts          parse + validate a wire frame → RecordedFrame
│   ├── pid-impersonation.ts         build proxy pid.json, backup/restore real one
│   ├── scrub.ts                     redact tokens + home paths in a recording
│   ├── proxy-server.ts              Bun.serve: /activity + /rpc + /stream forwarding
│   └── main.ts                      orchestrator: read slot pid.json, run, restore
└── src/__tests__/
    ├── recorder.test.ts
    ├── frame-classifier.test.ts
    ├── pid-impersonation.test.ts
    ├── scrub.test.ts
    └── proxy-server.test.ts         integration vs a fake upstream Bun WS server
```

Root `package.json`: add `"tools/*"` to `workspaces`.
Root `.gitignore` (or the package `.gitignore`): ignore `tools/capture-proxy/recordings/`.

---

### Task 1: Scaffold the `@traycer-tools/capture-proxy` package

**Files:**
- Create: `tools/capture-proxy/package.json`
- Create: `tools/capture-proxy/tsconfig.json`
- Create: `tools/capture-proxy/vitest.config.ts`
- Create: `tools/capture-proxy/.gitignore`
- Create: `tools/capture-proxy/src/__tests__/smoke.test.ts`
- Modify: `package.json` (root `workspaces` array)

**Interfaces:**
- Consumes: nothing.
- Produces: a resolvable workspace where `bun test` runs and `@traycer/protocol/*` imports resolve.

- [ ] **Step 1: Write the failing test**

`tools/capture-proxy/src/__tests__/smoke.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { clientFrameSchema } from "@traycer/protocol/framework/ws-protocol";

describe("capture-proxy scaffold", () => {
  it("resolves the protocol frame schema from source", () => {
    const parsed = clientFrameSchema.safeParse({
      kind: "request",
      requestId: "r1",
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      params: {},
    });
    expect(parsed.success).toBe(true);
  });
});
```

- [ ] **Step 2: Create the package manifest and config**

`tools/capture-proxy/package.json`:
```json
{
  "name": "@traycer-tools/capture-proxy",
  "license": "MIT",
  "private": true,
  "type": "module",
  "scripts": {
    "compile": "tsc --noEmit",
    "lint": "eslint . --cache --fix --max-warnings 0",
    "format": "bun x prettier --write .",
    "test": "vitest run"
  },
  "dependencies": {
    "@traycer/protocol": "workspace:*",
    "zod": "catalog:"
  },
  "devDependencies": {
    "@types/node": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

`tools/capture-proxy/tsconfig.json` (mirror `clients/shared/tsconfig.json` — read it first and copy its `extends`/`compilerOptions` shape; if it has no base to extend, use):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "types": ["node"],
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`tools/capture-proxy/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
```

`tools/capture-proxy/.gitignore`:
```
recordings/
```

- [ ] **Step 3: Register the workspace**

Edit root `package.json`: change `"workspaces": ["protocol", "clients/*"]` to `"workspaces": ["protocol", "clients/*", "tools/*"]`. Then run `bun install` from the repo root to link the new workspace.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run --root tools/capture-proxy`
Expected: PASS (1 test). If `@traycer/protocol/framework/ws-protocol` fails to resolve, confirm `bun install` linked the workspace and that the protocol `exports` map contains `"./framework/*"`.

- [ ] **Step 5: Commit**

```bash
git add tools/capture-proxy package.json bun.lock
git commit -s -m "scaffold capture-proxy workspace"
```

---

### Task 2: Append-only JSONL recorder

**Files:**
- Create: `tools/capture-proxy/src/recorder.ts`
- Test: `tools/capture-proxy/src/__tests__/recorder.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type RecordedFrame = { ts: number; connId: string; leg: "rpc" | "stream"; direction: "c2h" | "h2c"; kind: string; method: string | null; schemaVersion: { major: number; minor: number } | null; payload: unknown }`
  - `class Recorder { constructor(filePath: string); append(frame: RecordedFrame): Promise<void>; close(): Promise<void> }`

- [ ] **Step 1: Write the failing test**

`tools/capture-proxy/src/__tests__/recorder.test.ts`:
```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Recorder, type RecordedFrame } from "../recorder";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cap-rec-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function frame(overrides: Partial<RecordedFrame>): RecordedFrame {
  return {
    ts: 1,
    connId: "c1",
    leg: "rpc",
    direction: "c2h",
    kind: "request",
    method: "host.status",
    schemaVersion: { major: 1, minor: 0 },
    payload: {},
    ...overrides,
  };
}

describe("Recorder", () => {
  it("writes one JSON object per line, in order", async () => {
    const file = join(dir, "rec.jsonl");
    const recorder = new Recorder(file);
    await recorder.append(frame({ ts: 1 }));
    await recorder.append(frame({ ts: 2, direction: "h2c", kind: "response" }));
    await recorder.close();

    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).ts).toBe(1);
    expect(JSON.parse(lines[1]).kind).toBe("response");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run --root tools/capture-proxy recorder`
Expected: FAIL ("Cannot find module '../recorder'").

- [ ] **Step 3: Write minimal implementation**

`tools/capture-proxy/src/recorder.ts`:
```ts
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type RecordedFrame = {
  readonly ts: number;
  readonly connId: string;
  readonly leg: "rpc" | "stream";
  readonly direction: "c2h" | "h2c";
  readonly kind: string;
  readonly method: string | null;
  readonly schemaVersion: { readonly major: number; readonly minor: number } | null;
  readonly payload: unknown;
};

export class Recorder {
  private stream: WriteStream | null = null;

  constructor(private readonly filePath: string) {}

  async append(frame: RecordedFrame): Promise<void> {
    if (this.stream === null) {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.stream = createWriteStream(this.filePath, { flags: "a" });
    }
    const line = `${JSON.stringify(frame)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.stream?.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    const stream = this.stream;
    if (stream === null) return;
    this.stream = null;
    await new Promise<void>((resolve) => stream.end(resolve));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run --root tools/capture-proxy recorder`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/capture-proxy/src/recorder.ts tools/capture-proxy/src/__tests__/recorder.test.ts
git commit -s -m "add jsonl recorder for capture proxy"
```

---

### Task 3: Frame classifier (parse + validate + tag)

**Files:**
- Create: `tools/capture-proxy/src/frame-classifier.ts`
- Test: `tools/capture-proxy/src/__tests__/frame-classifier.test.ts`

**Interfaces:**
- Consumes: `RecordedFrame` from `recorder.ts`; `clientFrameSchema`, `hostFrameSchema` from `@traycer/protocol/framework/ws-protocol`.
- Produces:
  - `function classifyFrame(input: { raw: string; connId: string; leg: "rpc" | "stream"; direction: "c2h" | "h2c"; ts: number }): { frame: RecordedFrame; valid: boolean }`

  Rules: `JSON.parse` the raw text. Validate `c2h` frames against `clientFrameSchema`, `h2c` against `hostFrameSchema`; `valid` reflects the parse result but the frame is recorded regardless. Extract `kind` (string; `"unparseable"` if JSON.parse throws), `method` (from `method` field if present else `null`), `schemaVersion` (from the frame if present else `null`).

- [ ] **Step 1: Write the failing test**

`tools/capture-proxy/src/__tests__/frame-classifier.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { classifyFrame } from "../frame-classifier";

describe("classifyFrame", () => {
  it("classifies a valid client request frame", () => {
    const raw = JSON.stringify({
      kind: "request",
      requestId: "r1",
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      params: {},
    });
    const { frame, valid } = classifyFrame({
      raw,
      connId: "c1",
      leg: "rpc",
      direction: "c2h",
      ts: 5,
    });
    expect(valid).toBe(true);
    expect(frame.kind).toBe("request");
    expect(frame.method).toBe("host.status");
    expect(frame.schemaVersion).toEqual({ major: 1, minor: 0 });
  });

  it("records unparseable text without throwing", () => {
    const { frame, valid } = classifyFrame({
      raw: "not json",
      connId: "c1",
      leg: "rpc",
      direction: "c2h",
      ts: 6,
    });
    expect(valid).toBe(false);
    expect(frame.kind).toBe("unparseable");
    expect(frame.method).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run --root tools/capture-proxy frame-classifier`
Expected: FAIL ("Cannot find module '../frame-classifier'").

- [ ] **Step 3: Write minimal implementation**

`tools/capture-proxy/src/frame-classifier.ts`:
```ts
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
  if (typeof rec.major !== "number" || typeof rec.minor !== "number") return null;
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
  const schema = input.direction === "c2h" ? clientFrameSchema : hostFrameSchema;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run --root tools/capture-proxy frame-classifier`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/capture-proxy/src/frame-classifier.ts tools/capture-proxy/src/__tests__/frame-classifier.test.ts
git commit -s -m "add wire frame classifier for capture proxy"
```

---

### Task 4: pid.json impersonation (build + backup/restore)

**Files:**
- Create: `tools/capture-proxy/src/pid-impersonation.ts`
- Test: `tools/capture-proxy/src/__tests__/pid-impersonation.test.ts`

**Interfaces:**
- Consumes: `isValidLocalHostWebsocketUrl` from `@traycer-clients/traycer-cli`'s `src/host/pid-metadata.ts` — but that package is not a dependency; instead **re-derive the check locally** to avoid a cross-package import, and assert equivalence in the test by constructing only `ws://127.0.0.1:<port>/rpc` URLs.
- Produces:
  - `type ProxyPidMetadata = { pid: number; hostId: string; version: string; websocketUrl: string; startedAt: string }`
  - `function buildProxyPidMetadata(input: { realMetadata: { hostId: string; version: string }; proxyPort: number; pid: number; nowIso: string }): ProxyPidMetadata`
  - `async function swapPidFile(pidPath: string, next: ProxyPidMetadata): Promise<{ restore: () => Promise<void> }>` — reads current bytes (or null), writes `next` atomically (temp + rename), returns a `restore()` that rewrites the original bytes or unlinks if there were none.

  `websocketUrl` MUST be exactly `ws://127.0.0.1:<proxyPort>/rpc`. `processStartIdentity` is deliberately omitted (null) so the desktop's identity comparison is skipped (fail-open).

- [ ] **Step 1: Write the failing test**

`tools/capture-proxy/src/__tests__/pid-impersonation.test.ts`:
```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProxyPidMetadata, swapPidFile } from "../pid-impersonation";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cap-pid-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("buildProxyPidMetadata", () => {
  it("emits a loopback /rpc url with no processStartIdentity", () => {
    const meta = buildProxyPidMetadata({
      realMetadata: { hostId: "h1", version: "9.9.9" },
      proxyPort: 51234,
      pid: 4242,
      nowIso: "2026-08-14T00:00:00.000Z",
    });
    expect(meta.websocketUrl).toBe("ws://127.0.0.1:51234/rpc");
    expect(meta.pid).toBe(4242);
    expect("processStartIdentity" in meta).toBe(false);
  });
});

describe("swapPidFile", () => {
  it("restores the original bytes on restore()", async () => {
    const pidPath = join(dir, "pid.json");
    await writeFile(pidPath, '{"original":true}', "utf8");
    const next = buildProxyPidMetadata({
      realMetadata: { hostId: "h1", version: "9.9.9" },
      proxyPort: 51234,
      pid: 4242,
      nowIso: "2026-08-14T00:00:00.000Z",
    });
    const { restore } = await swapPidFile(pidPath, next);
    expect(JSON.parse(await readFile(pidPath, "utf8")).pid).toBe(4242);
    await restore();
    expect(await readFile(pidPath, "utf8")).toBe('{"original":true}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run --root tools/capture-proxy pid-impersonation`
Expected: FAIL ("Cannot find module '../pid-impersonation'").

- [ ] **Step 3: Write minimal implementation**

`tools/capture-proxy/src/pid-impersonation.ts`:
```ts
import { readFile, rename, rm, writeFile } from "node:fs/promises";

export type ProxyPidMetadata = {
  readonly pid: number;
  readonly hostId: string;
  readonly version: string;
  readonly websocketUrl: string;
  readonly startedAt: string;
};

export function buildProxyPidMetadata(input: {
  realMetadata: { hostId: string; version: string };
  proxyPort: number;
  pid: number;
  nowIso: string;
}): ProxyPidMetadata {
  return {
    pid: input.pid,
    hostId: input.realMetadata.hostId,
    version: input.realMetadata.version,
    websocketUrl: `ws://127.0.0.1:${input.proxyPort}/rpc`,
    startedAt: input.nowIso,
  };
}

export async function swapPidFile(
  pidPath: string,
  next: ProxyPidMetadata,
): Promise<{ restore: () => Promise<void> }> {
  let original: string | null;
  try {
    original = await readFile(pidPath, "utf8");
  } catch {
    original = null;
  }
  const tmp = `${pidPath}.proxy-tmp`;
  await writeFile(tmp, JSON.stringify(next), "utf8");
  await rename(tmp, pidPath);
  return {
    restore: async () => {
      if (original === null) {
        await rm(pidPath, { force: true });
        return;
      }
      const restoreTmp = `${pidPath}.restore-tmp`;
      await writeFile(restoreTmp, original, "utf8");
      await rename(restoreTmp, pidPath);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run --root tools/capture-proxy pid-impersonation`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/capture-proxy/src/pid-impersonation.ts tools/capture-proxy/src/__tests__/pid-impersonation.test.ts
git commit -s -m "add pid.json impersonation for capture proxy"
```

---

### Task 5: Scrub pass (redact tokens + home paths)

**Files:**
- Create: `tools/capture-proxy/src/scrub.ts`
- Test: `tools/capture-proxy/src/__tests__/scrub.test.ts`

**Interfaces:**
- Consumes: `RecordedFrame` from `recorder.ts`.
- Produces:
  - `function scrubFrame(frame: RecordedFrame, homeDir: string): RecordedFrame` — deep-clones `payload`, replaces any string value under a key named `token` (case-insensitive) with `"<redacted-token>"`, and replaces every occurrence of `homeDir` inside string values with `"<home>"`. Returns a new frame.
  - `async function scrubRecording(input: { inPath: string; outPath: string; homeDir: string }): Promise<{ count: number }>` — reads JSONL, scrubs each line, writes JSONL.

- [ ] **Step 1: Write the failing test**

`tools/capture-proxy/src/__tests__/scrub.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { scrubFrame } from "../scrub";
import type { RecordedFrame } from "../recorder";

const base: RecordedFrame = {
  ts: 1,
  connId: "c1",
  leg: "rpc",
  direction: "c2h",
  kind: "open",
  method: null,
  schemaVersion: null,
  payload: {},
};

describe("scrubFrame", () => {
  it("redacts token fields and home paths", () => {
    const frame: RecordedFrame = {
      ...base,
      payload: {
        kind: "open",
        token: "secret-jwt-value",
        manifest: { cwd: "/Users/alex/code/app" },
      },
    };
    const scrubbed = scrubFrame(frame, "/Users/alex");
    const payload = scrubbed.payload as {
      token: string;
      manifest: { cwd: string };
    };
    expect(payload.token).toBe("<redacted-token>");
    expect(payload.manifest.cwd).toBe("<home>/code/app");
  });

  it("does not mutate the input frame", () => {
    const frame: RecordedFrame = { ...base, payload: { token: "x" } };
    scrubFrame(frame, "/Users/alex");
    expect((frame.payload as { token: string }).token).toBe("x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run --root tools/capture-proxy scrub`
Expected: FAIL ("Cannot find module '../scrub'").

- [ ] **Step 3: Write minimal implementation**

`tools/capture-proxy/src/scrub.ts`:
```ts
import { readFile, writeFile } from "node:fs/promises";
import type { RecordedFrame } from "./recorder";

function scrubValue(value: unknown, keyName: string, homeDir: string): unknown {
  if (typeof value === "string") {
    if (keyName.toLowerCase() === "token") return "<redacted-token>";
    return homeDir.length > 0 ? value.split(homeDir).join("<home>") : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, "", homeDir));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = scrubValue(v, k, homeDir);
    }
    return out;
  }
  return value;
}

export function scrubFrame(frame: RecordedFrame, homeDir: string): RecordedFrame {
  return { ...frame, payload: scrubValue(frame.payload, "", homeDir) };
}

export async function scrubRecording(input: {
  inPath: string;
  outPath: string;
  homeDir: string;
}): Promise<{ count: number }> {
  const lines = (await readFile(input.inPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const scrubbed = lines.map((line) => {
    const frame = JSON.parse(line) as RecordedFrame;
    return JSON.stringify(scrubFrame(frame, input.homeDir));
  });
  await writeFile(input.outPath, `${scrubbed.join("\n")}\n`, "utf8");
  return { count: scrubbed.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run --root tools/capture-proxy scrub`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/capture-proxy/src/scrub.ts tools/capture-proxy/src/__tests__/scrub.test.ts
git commit -s -m "add scrub pass for capture recordings"
```

---

### Task 6: Proxy server (Bun.serve WS forwarding + /activity)

**Files:**
- Create: `tools/capture-proxy/src/proxy-server.ts`
- Test: `tools/capture-proxy/src/__tests__/proxy-server.test.ts`

**Interfaces:**
- Consumes: `Recorder` (Task 2), `classifyFrame` (Task 3).
- Produces:
  - `type ProxyServer = { port: number; stop: () => Promise<void> }`
  - `async function startProxyServer(input: { upstreamRpcUrl: string; upstreamStreamUrl: string; recorder: Recorder; port: number }): Promise<ProxyServer>` — starts `Bun.serve` on `127.0.0.1:port`. `GET /activity` returns `200 "ok"`. WebSocket upgrades on `/rpc` and `/stream` each open an upstream `WebSocket` to the matching upstream URL; every message in either direction is `classifyFrame`d, appended via `recorder.append`, then forwarded verbatim. `port: 0` selects an ephemeral port (read back from `server.port`).

  Forwarding contract: client→upstream messages are buffered until the upstream socket is `OPEN`, then flushed in order (the client sends `open`/`request` immediately on connect, before upstream finishes connecting).

- [ ] **Step 1: Write the failing test** (integration against a fake upstream — no real host needed)

`tools/capture-proxy/src/__tests__/proxy-server.test.ts`:
```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Recorder } from "../recorder";
import { startProxyServer, type ProxyServer } from "../proxy-server";

let dir: string;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let proxy: ProxyServer | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cap-proxy-"));
});
afterEach(async () => {
  await proxy?.stop();
  upstream?.stop(true);
  await rm(dir, { recursive: true, force: true });
});

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > 4000) return reject(new Error("timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("startProxyServer", () => {
  it("forwards /rpc frames both ways and records them", async () => {
    // Fake upstream host: echoes an openAck then a response.
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (server.upgrade(req)) return undefined;
        return new Response("no");
      },
      websocket: {
        message(ws, msg) {
          const frame = JSON.parse(String(msg));
          if (frame.kind === "open") ws.send(JSON.stringify({ kind: "openAck", manifest: {} }));
          if (frame.kind === "request")
            ws.send(
              JSON.stringify({
                kind: "response",
                requestId: frame.requestId,
                method: frame.method,
                schemaVersion: frame.schemaVersion,
                result: { ok: true },
                error: null,
              }),
            );
        },
      },
    });
    const upstreamUrl = `ws://127.0.0.1:${upstream.port}/rpc`;
    const recFile = join(dir, "rec.jsonl");
    const recorder = new Recorder(recFile);
    proxy = await startProxyServer({
      upstreamRpcUrl: upstreamUrl,
      upstreamStreamUrl: upstreamUrl.replace("/rpc", "/stream"),
      recorder,
      port: 0,
    });

    const received: unknown[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/rpc`);
    client.onopen = () => {
      client.send(JSON.stringify({ kind: "open", token: "t", manifest: {} }));
      client.send(
        JSON.stringify({
          kind: "request",
          requestId: "r1",
          method: "host.status",
          schemaVersion: { major: 1, minor: 0 },
          params: {},
        }),
      );
    };
    client.onmessage = (ev) => received.push(JSON.parse(String(ev.data)));

    await waitFor(() => received.some((f) => (f as { kind: string }).kind === "response"));
    client.close();
    await recorder.close();

    const activity = await fetch(`http://127.0.0.1:${proxy.port}/activity`);
    expect(activity.status).toBe(200);

    const lines = (await readFile(recFile, "utf8")).trim().split("\n");
    const kinds = lines.map((l) => JSON.parse(l).kind);
    expect(kinds).toContain("open");
    expect(kinds).toContain("openAck");
    expect(kinds).toContain("response");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run --root tools/capture-proxy proxy-server`
Expected: FAIL ("Cannot find module '../proxy-server'").

- [ ] **Step 3: Write minimal implementation**

`tools/capture-proxy/src/proxy-server.ts`:
```ts
import type { ServerWebSocket } from "bun";
import { classifyFrame } from "./frame-classifier";
import type { Recorder } from "./recorder";

export type ProxyServer = { port: number; stop: () => Promise<void> };

type Leg = "rpc" | "stream";
type ConnState = {
  connId: string;
  leg: Leg;
  upstream: WebSocket;
  outbox: string[];
  upstreamOpen: boolean;
};

let connCounter = 0;

export async function startProxyServer(input: {
  upstreamRpcUrl: string;
  upstreamStreamUrl: string;
  recorder: Recorder;
  port: number;
}): Promise<ProxyServer> {
  const record = (
    connId: string,
    leg: Leg,
    direction: "c2h" | "h2c",
    raw: string,
  ): void => {
    const { frame } = classifyFrame({
      raw,
      connId,
      leg,
      direction,
      ts: Date.now(),
    });
    void input.recorder.append(frame);
  };

  const server = Bun.serve<ConnState>({
    port: input.port,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/activity") return new Response("ok");
      if (url.pathname !== "/rpc" && url.pathname !== "/stream") {
        return new Response("not found", { status: 404 });
      }
      const leg: Leg = url.pathname === "/rpc" ? "rpc" : "stream";
      const connId = `conn-${(connCounter += 1)}`;
      const upstreamUrl = leg === "rpc" ? input.upstreamRpcUrl : input.upstreamStreamUrl;
      const upstream = new WebSocket(upstreamUrl);
      const state: ConnState = { connId, leg, upstream, outbox: [], upstreamOpen: false };
      if (srv.upgrade(req, { data: state })) return undefined;
      return new Response("upgrade failed", { status: 500 });
    },
    websocket: {
      open(ws: ServerWebSocket<ConnState>) {
        const state = ws.data;
        state.upstream.onopen = () => {
          state.upstreamOpen = true;
          for (const msg of state.outbox) state.upstream.send(msg);
          state.outbox = [];
        };
        state.upstream.onmessage = (ev) => {
          const raw = String(ev.data);
          record(state.connId, state.leg, "h2c", raw);
          ws.send(raw);
        };
        state.upstream.onclose = () => ws.close();
        state.upstream.onerror = () => ws.close();
      },
      message(ws: ServerWebSocket<ConnState>, msg) {
        const state = ws.data;
        const raw = String(msg);
        record(state.connId, state.leg, "c2h", raw);
        if (state.upstreamOpen) state.upstream.send(raw);
        else state.outbox.push(raw);
      },
      close(ws: ServerWebSocket<ConnState>) {
        try {
          ws.data.upstream.close();
        } catch {
          // upstream already closed
        }
      },
    },
  });

  return {
    port: server.port,
    stop: async () => {
      server.stop(true);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run --root tools/capture-proxy proxy-server`
Expected: PASS. (This test needs the Bun test runtime; run it with `bunx vitest`, which uses Bun. If `Bun.serve`/`ServerWebSocket` types are unresolved at compile, add `bun-types` to devDependencies and `"types": ["node", "bun"]` in tsconfig.)

- [ ] **Step 5: Commit**

```bash
git add tools/capture-proxy/src/proxy-server.ts tools/capture-proxy/src/__tests__/proxy-server.test.ts
git commit -s -m "add ws forwarding proxy server with recording"
```

---

### Task 7: Orchestrator + capture runbook

**Files:**
- Create: `tools/capture-proxy/src/main.ts`
- Create: `tools/capture-proxy/README.md`
- Test: none automated (this task wires together already-tested units and drives real processes; correctness is proven by the manual runbook).

**Interfaces:**
- Consumes: `startProxyServer`, `swapPidFile`, `buildProxyPidMetadata`, `Recorder`.
- Produces: an executable entry (`bun run tools/capture-proxy/src/main.ts --pid-file <path> --out <path>`) that: reads the real host `pid.json` at `--pid-file`, extracts `websocketUrl` (real `/rpc`) and derives the `/stream` URL, starts the recorder + proxy on an ephemeral port, swaps `pid.json` to point at the proxy, and on `SIGINT` restores `pid.json`, closes the recorder, and exits.

- [ ] **Step 1: Write `main.ts`**

`tools/capture-proxy/src/main.ts`:
```ts
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Recorder } from "./recorder";
import { buildProxyPidMetadata, swapPidFile } from "./pid-impersonation";
import { startProxyServer } from "./proxy-server";

async function readRealMetadata(pidFile: string): Promise<{
  hostId: string;
  version: string;
  rpcUrl: string;
  streamUrl: string;
}> {
  const parsed = JSON.parse(await readFile(pidFile, "utf8")) as Record<string, unknown>;
  const websocketUrl = parsed.websocketUrl;
  const hostId = parsed.hostId;
  const version = parsed.version;
  if (
    typeof websocketUrl !== "string" ||
    typeof hostId !== "string" ||
    typeof version !== "string"
  ) {
    throw new Error(`Malformed pid.json at ${pidFile}`);
  }
  return {
    hostId,
    version,
    rpcUrl: websocketUrl,
    streamUrl: websocketUrl.replace(/\/rpc$/, "/stream"),
  };
}

async function run(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "pid-file": { type: "string" },
      out: { type: "string" },
    },
  });
  const pidFile = values["pid-file"];
  const out = values.out;
  if (typeof pidFile !== "string" || typeof out !== "string") {
    throw new Error("Usage: main.ts --pid-file <path> --out <recording.jsonl>");
  }

  const real = await readRealMetadata(pidFile);
  const recorder = new Recorder(out);
  const proxy = await startProxyServer({
    upstreamRpcUrl: real.rpcUrl,
    upstreamStreamUrl: real.streamUrl,
    recorder,
    port: 0,
  });
  const meta = buildProxyPidMetadata({
    realMetadata: { hostId: real.hostId, version: real.version },
    proxyPort: proxy.port,
    pid: process.pid,
    nowIso: new Date().toISOString(),
  });
  const { restore } = await swapPidFile(pidFile, meta);

  process.stdout.write(
    `capture-proxy listening on ws://127.0.0.1:${proxy.port}/rpc\n` +
      `upstream ${real.rpcUrl}\nrecording -> ${out}\nCtrl-C to stop\n`,
  );

  const shutdown = async (): Promise<void> => {
    await restore();
    await proxy.stop();
    await recorder.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise<void>(() => {});
}

void run();
```

- [ ] **Step 2: Compile-check**

Run: `bunx tsc --noEmit -p tools/capture-proxy/tsconfig.json`
Expected: no errors. (Fix any type issues before proceeding.)

- [ ] **Step 3: Write the capture runbook**

`tools/capture-proxy/README.md` — document the manual capture procedure verbatim:
```markdown
# capture-proxy

Records the JSON RPC/stream traffic between the Traycer desktop app and the
real signed host, to produce replay fixtures for the open host.

## Prerequisites
- A working Traycer desktop install signed in to your account.
- This repo installed (`bun install`).

## Procedure
1. Start the desktop dev host so a dev-slot `pid.json` exists:
   `make dev-desktop` (leave it running). Note the dev pid.json path printed by
   the CLI, typically `~/.traycer/host/dev/pid.json` or
   `~/.traycer/host/dev-runs/<slot>/pid.json`.
2. In a second terminal, start the proxy pointed at that pid.json:
   `bun run src/main.ts --pid-file <pid.json path> --out recordings/boot.jsonl`
   The proxy rewrites pid.json to point the app at itself.
3. In the desktop app: it will reconnect through the proxy. For the **boot**
   recording, just let it reach the idle window, then Ctrl-C the proxy.
4. Re-run with `--out recordings/task-flow.jsonl` and, in the app, create a
   task, start an agent, send one message, watch output, then Ctrl-C.
5. Scrub before committing a fixture (see Scrubbing).

## Scrubbing
Run the scrub entry over each raw recording, then review the output by eye for
any residual secrets before committing it under `fixtures/`:
`bun run src/scrub-cli.ts --in recordings/boot.jsonl --out fixtures/boot.scrubbed.jsonl`

## Safety
- `recordings/` is gitignored. Never commit raw recordings.
- The proxy restores the original pid.json on Ctrl-C; if it crashes, restart
  `make dev-desktop` to regenerate a clean pid.json.
```

- [ ] **Step 4: Commit**

```bash
git add tools/capture-proxy/src/main.ts tools/capture-proxy/README.md
git commit -s -m "add capture proxy orchestrator and runbook"
```

---

### Task 8: Scrub CLI + committed fixtures + gitignore

**Files:**
- Create: `tools/capture-proxy/src/scrub-cli.ts`
- Create: `tools/capture-proxy/fixtures/.gitkeep`
- Modify: root `.gitignore` (ignore raw recordings dir)
- Test: `tools/capture-proxy/src/__tests__/fixtures.test.ts` (guards fixture shape once produced)

**Interfaces:**
- Consumes: `scrubRecording` (Task 5).
- Produces: `bun run src/scrub-cli.ts --in <raw.jsonl> --out <scrubbed.jsonl>`; a `fixtures/` directory for reviewed, scrubbed recordings that Plans 2–3 import.

- [ ] **Step 1: Write the scrub CLI**

`tools/capture-proxy/src/scrub-cli.ts`:
```ts
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { scrubRecording } from "./scrub";

async function run(): Promise<void> {
  const { values } = parseArgs({
    options: { in: { type: "string" }, out: { type: "string" } },
  });
  const inPath = values.in;
  const outPath = values.out;
  if (typeof inPath !== "string" || typeof outPath !== "string") {
    throw new Error("Usage: scrub-cli.ts --in <raw.jsonl> --out <scrubbed.jsonl>");
  }
  const { count } = await scrubRecording({ inPath, outPath, homeDir: homedir() });
  process.stdout.write(`scrubbed ${count} frames -> ${outPath}\n`);
}

void run();
```

- [ ] **Step 2: Write the fixture guard test**

`tools/capture-proxy/src/__tests__/fixtures.test.ts`:
```ts
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const bootFixture = join(__dirname, "..", "..", "fixtures", "boot.scrubbed.jsonl");

describe("committed fixtures", () => {
  it.skipIf(!existsSync(bootFixture))(
    "contains no residual bearer tokens",
    async () => {
      const text = await readFile(bootFixture, "utf8");
      for (const line of text.trim().split("\n")) {
        const frame = JSON.parse(line) as { payload: unknown };
        const json = JSON.stringify(frame.payload);
        expect(json).not.toMatch(/"token":"(?!<redacted-token>)/);
      }
    },
  );
});
```

This test self-skips until a fixture exists (the fixture is produced by the manual runbook), then guards that no unredacted `token` survives.

- [ ] **Step 3: Wire gitignore + fixtures dir**

Add to root `.gitignore`:
```
tools/capture-proxy/recordings/
```
Create `tools/capture-proxy/fixtures/.gitkeep` (empty) so the reviewed-fixtures directory is tracked while raw recordings are not.

- [ ] **Step 4: Run the full package test suite**

Run: `bunx vitest run --root tools/capture-proxy`
Expected: PASS — recorder, frame-classifier, pid-impersonation, scrub, proxy-server green; fixtures test skipped.

- [ ] **Step 5: Commit**

```bash
git add tools/capture-proxy/src/scrub-cli.ts tools/capture-proxy/src/__tests__/fixtures.test.ts tools/capture-proxy/fixtures/.gitkeep .gitignore
git commit -s -m "add scrub cli and fixtures scaffold"
```

---

### Task 9 (manual, gated): capture the two sessions and commit scrubbed fixtures

This task is performed by the human operator with a real signed host; it produces the artifacts Plans 2–3 depend on. It has no automated test of its own — the automated fixture guard (Task 8) validates the output.

- [ ] **Step 1:** Follow `tools/capture-proxy/README.md` to record `recordings/boot.jsonl` and `recordings/task-flow.jsonl`.
- [ ] **Step 2:** Scrub each into `fixtures/boot.scrubbed.jsonl` and `fixtures/task-flow.scrubbed.jsonl`.
- [ ] **Step 3:** Manually review both scrubbed files for residual secrets (tokens, emails, absolute paths, workspace names you don't want public).
- [ ] **Step 4:** Run `bunx vitest run --root tools/capture-proxy` — the fixtures guard now runs and must pass.
- [ ] **Step 5:** Commit the scrubbed fixtures:
```bash
git add tools/capture-proxy/fixtures/boot.scrubbed.jsonl tools/capture-proxy/fixtures/task-flow.scrubbed.jsonl
git commit -s -m "add scrubbed capture fixtures for boot and task flow"
```

---

## Self-Review

**Spec coverage** (against the spec's "Capture accelerator" section):
- Loopback interpose between client and real host → Tasks 6–7. ✅
- Plain-JSON decode + frame-schema validation → Task 3. ✅
- JSONL records `{ts, direction, kind, method, schemaVersion, payload}` → Tasks 2–3 (`RecordedFrame` carries exactly these). ✅
- `pid.json` as the injection point (no env override) → Task 4 + Task 7. ✅
- Two scripted sessions (cold boot, task flow) → Task 9 + runbook. ✅
- Secrets hygiene: gitignored raw dir + scrub before fixture → Tasks 5, 8, 9. ✅
- Fixtures consumed by later replay tests → `fixtures/` committed in Task 9; Plans 2–3 import them. ✅

**Placeholder scan:** no "TBD"/"handle edge cases"/"similar to Task N" — every code step carries full source. The only non-automated steps (Tasks 7 step-wiring and Task 9) are inherently manual (drive real processes/app) and are explicitly marked as such with a concrete runbook. ✅

**Type consistency:** `RecordedFrame` shape is identical in `recorder.ts` (defined), `frame-classifier.ts` (produces), `scrub.ts` (transforms), `proxy-server.ts` (via `classifyFrame`). `ProxyPidMetadata` defined in Task 4, consumed in Task 7. `startProxyServer` signature in Task 6 matches its call in Task 7. `scrubRecording`/`scrubFrame` names consistent across Tasks 5 and 8. ✅

**Note carried to Plan 2:** the desktop's endpoint-reachability check reads `pid.json` and (when `processStartIdentity` is present) verifies process identity; Plan 1 relies on *omitting* that field to fail-open. If capture in Task 9 shows the desktop refusing the proxy endpoint, the fallback is to populate `processStartIdentity` for the proxy's own pid — surface this immediately rather than working around it.
