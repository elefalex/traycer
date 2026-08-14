---
project: traycer
type: spec
status: active
date: 2026-08-14
title: Open Host — Milestone 1 (GUI connects, one agent runs)
summary: Replace the proprietary Traycer host with an in-repo open-source host so the desktop app runs a live Claude Code agent fully locally, with no cloud auth, sync, or billing.
---

# Open Host — Milestone 1 Design

## Context

This fork of `traycerai/traycer` contains the MIT-licensed clients (desktop,
gui-app, traycer-cli, shared) and the `@traycer/protocol` wire contract. The
**host** — the daemon that actually runs agents and owns all state — is a
proprietary signed binary downloaded from upstream's GitHub Releases, and it
talks to Traycer's closed cloud for auth, sync, collaboration, and billing.

Goal of the overall project: a fully open-source Traycer that works with any
model, has no cloud/sync/pricing dependency, and (in a later milestone) exposes
a pluggable ticketing system that can integrate with superpowers or any
user-customizable workflow. Inspiration: `nexu-io/open-design` (local-first,
agents-on-PATH, no accounts) — but unlike open-design we fork rather than
reimplement, because the entire client stack and protocol are already open.

## Decisions made during brainstorming

- **Strategy:** build an open host inside the fork that implements the existing
  client⇄host protocol. Do not reimplement the clients; do not go host-less.
- **Milestone 1 success criterion:** desktop app opens → connects to the open
  host → user creates a task → a real Claude Code session runs in it → message
  round-trip visible → clean shutdown. Tickets/epics UI comes later.
- **Upstream posture:** track upstream (merge from `traycerai/traycer`
  regularly); keep client changes surgical so merges stay cheap. Cut the cord
  later only if ticketing customization demands client changes upstream would
  reject.
- **Audience:** the author only, for now. No packaging, signing, branding, or
  release engineering in this milestone.
- **Method:** implement-on-demand driven by the GUI's actual RPC calls, with a
  week-zero **capture accelerator** — proxy the real signed host and record the
  boot and task flows so the required RPC surface is known, not guessed.

## Architecture

Two new top-level additions; everything else stays as upstream ships it:

```
traycer/  (fork)
├── host/                    NEW  @traycer/open-host (Bun/TypeScript daemon)
├── tools/capture-proxy/     NEW  recording proxy (dev tool, throwaway-grade)
├── protocol/                untouched — host imports it from source
├── clients/                 near-untouched — surgical dev-config wiring only
```

The open host is a local daemon on the developer's machine, exactly like the
proprietary host: clients connect over a localhost WebSocket. Nothing runs in
the cloud. The protocol's "pre-split state" (protocol/README.md) explicitly
supports an in-repo host resolving `@traycer/protocol` straight from
TypeScript source, so no build-step changes are needed.

### Components of `host/`

| Component | Purpose |
|---|---|
| `server/` | Loopback listener that serves `GET /activity` (HTTP liveness), `ws://127.0.0.1:<port>/rpc` (one socket per unary request), and `.../stream` (long-lived subscriptions). Frames are **plain UTF-8 JSON text** discriminated by a `kind` field (`open`/`openAck`/`request`/`response`/`subscribe`/`fatalError`) — the binary `host-transport` mux/chunking and Noise apply only to the remote-relay path, which milestone 1 does not build |
| `bootstrap/` | On start: bind the loopback port, then write `<host-data-dir>/pid.json` (`{pid, hostId, version, websocketUrl: "ws://127.0.0.1:<port>/rpc", startedAt, processStartIdentity}`) and unlink it on graceful shutdown. This file is the client's **only** discovery channel; the desktop rejects any URL that is not `ws(s)://127.0.0.1:<port>/rpc`. Must tolerate CLI-supplied args `--host-data-dir <dir>`, `--layer0-attempt-id`, `--layer0-status-fd` |
| `handshake/` | On `open`, build the `openAck` manifest from `hostRpcRegistry`/`hostStreamRpcRegistry` via `buildConnectionManifest`/`splitConnectionManifest`, run `checkCompatibility(..., selfRole: "host")`. **Every one of the 113 `RELEASED_FLOOR_METHOD_NAMES` must appear in the manifest or the client hard-fatals as `INCOMPATIBLE`** — so the host serves a floor-stub layer (valid-shaped, minimal responses generated from the registry contracts) for all floor methods, with real logic swapped in per method on demand. The bearer token in the `open` frame is accepted and ignored (no cloud verification) |
| `rpc/` | Dispatcher routing decoded frames to domain modules; a method with neither real logic nor a floor stub returns a well-formed `response.error` and logs loudly (the log is the backlog) |
| `status/`, `config/`, `workspace/` | `host.status`, `host.getRuntimeCapabilities`, `host.identity.get`, and the `workspace.*`/`worktree.*` floor reads — the "GUI boots and renders" tier |
| `agent/` | Agent lifecycle (`agent.create`/`agent.list`/`agent.sendMessage`/`agent.stop`) + one harness: **Claude Code** — spawns `claude` in a PTY, streams output back over `chat.subscribe` and `terminal.subscribe` |
| `store/` | Minimal local persistence: JSON files under `~/.traycer-open/` with atomic writes (SQLite only if a later milestone forces it); capture data decides how much epic/chat schema milestone 1 actually requires |

### Client-side footprint (the entire set of fork changes to client code)

- A `make dev-open` target that: builds the open host, stages it as a directory
  containing an executable named `traycer-host`, and installs it into the dev
  slot via the surviving unsigned side-load path
  **`traycer host install --from <dir> --allow-self-invocation`** (sha256-only,
  no signature check; `--allow-empty-pubkeys` no longer exists), then launches
  the desktop app in dev config. The trust root is now committed in
  `clients/traycer-cli/src/config.ts`; the dogfood escape hatch that survives is
  `--allow-unpinned-host`.
- **A local-mode client auth patch is required, not optional.** The GUI cannot
  render signed-out (`WsRpcClient` throws before dialing without a bearer;
  `RootLandingPage` shows sign-in unless `authStatus === "signed-in"`; startup
  hits `GET /api/v3/user`, `POST /api/v3/auth/refresh`, `GET /api/v3/hosts`).
  Behind a `TRAYCER_LOCAL_MODE` flag the patch injects a static fake bearer
  source and returns a synthetic signed-in user for those three calls, forcing
  `authStatus` to `signed-in`. Kept minimal and flag-gated so upstream merges
  stay clean; the sign-in UI is left intact, just bypassed.

### Explicitly out of scope — never built

Cloud auth, cross-device sync, collaboration/sharing, rate-limit metering,
usage analytics, Traycer native inference, Sentry/PostHog telemetry.

## Capture accelerator

A small WebSocket man-in-the-middle used against the author's real, working
Traycer install:

- Listens on a loopback port, dials the real signed host's `ws://127.0.0.1/rpc`
  and `/stream`, pipes frames both ways unchanged — the app keeps working while
  recording.
- Frames are already plain JSON text, so decoding is `JSON.parse` validated
  against the protocol frame schemas (`clientFrameSchema`/`hostFrameSchema`);
  appends JSONL records `{ts, direction, kind, method, schemaVersion, payload}`.
- The client is pointed at the proxy by writing a `pid.json` whose
  `websocketUrl` is the proxy's loopback URL (the only injection point; there is
  no env-var override for the websocket URL).
- Two scripted sessions are recorded:
  1. **Cold boot** — app start through to idle window.
  2. **Task flow** — create task → agent session starts → send message →
     terminal output → close.
  These recordings define milestone 1's exact RPC surface in call order.
- Secrets hygiene: raw recordings live in a gitignored directory; a scrub pass
  strips tokens and machine paths before any recording is committed as a test
  fixture.

## Data flow (steady state)

```
GUI ──WS──▶ server (JSON.parse + frame-schema validate)
                │
                ▼
             rpc dispatcher ── unknown method ──▶ protocol error + backlog log
                │
                ▼
          domain module (agent/, status/, ...)
                │                     │
                ▼                     ▼
          store/ (disk)      harness: spawn `claude` in PTY
                                      │
                              stdout/events stream
                                      ▼
              server ◀── stream frames pushed back to GUI
```

Two interaction shapes, both defined by the protocol: **unary RPCs**
(request → response) and **streams** (subscriptions the GUI holds open:
host-status, terminal output, agent activity). The dispatcher treats them
uniformly; domain modules emit events, the server layer owns delivery.

## Error handling

- **Unimplemented RPC** → well-formed protocol error + one-line backlog log
  (method, version, caller context). Never crash, never hang the client. The
  GUI already degrades per-method because the handshake is negotiated.
- **Harness process death** → agent transitions to an error state via normal
  lifecycle events; PTY and temp state cleaned up; GUI shows a failed agent,
  not a zombie.
- **Host crash** → clients already reconnect (they survive host upgrades
  today). The host's only obligation: never corrupt the store on hard kill —
  atomic writes (write-temp-then-rename, or SQLite transactions).
- **Malformed/unexpected frames** → drop and log; never tear down the
  connection for one bad frame.

## Testing

- **Replay tests (primary):** scrubbed capture recordings become golden
  fixtures — feed recorded client frames into the open host and assert
  responses are schema-valid and shape-compatible with the real host's
  answers. Proves "boot works" without launching Electron.
- **Unit tests** per domain module (vitest, matching the repo): handshake
  negotiation, dispatcher routing, harness lifecycle against a fake PTY.
- **Protocol conformance for free:** every response validated against
  `@traycer/protocol` schemas in tests.
- **Manual E2E:** `make dev-open` → acceptance walk: app opens → task created
  → Claude Code session live → message round-trip → clean shutdown.

## Sequencing within milestone 1

The milestone is large enough to split into three sequenced plans, each of
which produces working, independently testable software:

1. **Capture harness** — proxy + two recordings + scrubbed replay fixtures.
   Testable on its own (record, then replay a session).
2. **Bring-up to GUI-renders** — host scaffold, `pid.json`/`/activity`
   bootstrap, JSON WebSocket server, handshake with the full 113-method floor
   stubbed, the `TRAYCER_LOCAL_MODE` client auth patch, and the
   status/config/workspace/identity tier. Deliverable: `make dev-open` opens the
   desktop app, it connects to the open host, and the main UI renders (no agent
   yet). Testable via replay fixtures + manual "app renders".
3. **Live agent** — agent lifecycle + Claude Code PTY harness + `chat.subscribe`
   / `terminal.subscribe`. Deliverable: the acceptance walk (create task →
   Claude Code session live → message round-trip → clean shutdown).

## Later milestones (recorded here, not designed)

Local epic/ticket persistence → pluggable ticketing adapters (superpowers
integration, GitHub Issues, plain markdown, user-defined) → additional
harnesses (Codex, Cursor, OpenCode, anything on PATH) → optional remote host
over the protocol's Noise transport → packaging/branding for a public release.
