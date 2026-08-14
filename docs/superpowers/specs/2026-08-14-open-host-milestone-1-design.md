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
| `server/` | Localhost WebSocket listener + `host-transport` mux/chunking framing |
| `handshake/` | Capability manifest + per-method `{major, minor}` negotiation; advertises only implemented methods |
| `rpc/` | Dispatcher routing decoded frames to domain modules; unimplemented methods return a well-formed protocol error and log loudly (the log is the backlog) |
| `identity/` | Local single-user identity stub — no cloud auth, no PKCE; satisfies the user/session RPCs the GUI needs to render |
| `status/`, `config/`, `workspace/` | host-status heartbeat, on-disk config store, workspace association — the "GUI boots and renders" tier |
| `agent/` | Agent lifecycle + one harness: **Claude Code** — spawns `claude` in a PTY, streams terminal/chat output back |
| `store/` | Minimal local persistence: JSON files under `~/.traycer-open/` with atomic writes (SQLite only if a later milestone forces it); capture data decides how much epic/chat schema milestone 1 actually requires |

### Client-side footprint (the entire set of fork changes to client code)

- A `make dev-open` target: starts the open host, then launches the desktop
  app in the existing dev config (localhost endpoints, empty host trust keys)
  via the CLI's existing unsigned-host side-load path
  (`scripts/set-deploy-target.cjs --allow-empty-pubkeys` / dogfood flow).
- No login-screen changes if the identity stub satisfies the GUI; if the GUI
  hard-requires a cloud auth flow to render, that becomes the one client
  patch, kept minimal and merge-friendly.

### Explicitly out of scope — never built

Cloud auth, cross-device sync, collaboration/sharing, rate-limit metering,
usage analytics, Traycer native inference, Sentry/PostHog telemetry.

## Capture accelerator

A small WebSocket man-in-the-middle used against the author's real, working
Traycer install:

- Listens on a local port, dials the real signed host, pipes frames both ways
  unchanged — the app keeps working while recording.
- Decodes every frame with `@traycer/protocol` source (same mux/chunking and
  schemas) and appends JSONL records: `{ts, direction, method, version, payload}`.
- The client is pointed at the proxy via the same dev-config endpoint override
  used everywhere else.
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
GUI ──WS──▶ server (mux/chunk decode)
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

1. Capture proxy + record the two sessions.
2. Server + handshake + dispatcher — GUI *connects* (window opens, even if
   mostly empty).
3. Status/config/workspace/identity tier — GUI *renders* fully.
4. Agent lifecycle + Claude Code harness + terminal streams — the acceptance
   walk passes.

## Later milestones (recorded here, not designed)

Local epic/ticket persistence → pluggable ticketing adapters (superpowers
integration, GitHub Issues, plain markdown, user-defined) → additional
harnesses (Codex, Cursor, OpenCode, anything on PATH) → optional remote host
over the protocol's Noise transport → packaging/branding for a public release.
