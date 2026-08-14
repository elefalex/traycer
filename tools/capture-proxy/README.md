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
   `~/.traycer/host/dev-runs/<slot>/pid.json` (slot-based when
   `DEV_DESKTOP_SLOT` is set). Production installs use
   `~/.traycer/host/pid.json` instead — the same procedure works there, but
   prefer a dev host for capture so you are not impersonating your production
   pid.json.
2. In a second terminal, start the proxy pointed at that pid.json:
   `bun run src/main.ts --pid-file <pid.json path> --out recordings/boot.jsonl`
   The proxy rewrites pid.json to point the app at itself.
3. **Quit and relaunch the desktop app** (the app only — do NOT re-run
   `make dev-desktop`, which spawns a fresh host and rewrites pid.json,
   undoing the swap). This is what makes the **boot** recording a real cold
   boot: letting the already-running app reconnect through the proxy records
   a mid-session reconnect and misses everything the app does only on first
   launch, which is precisely the call order this milestone is capturing.
4. Let the relaunched app reach the idle window, then Ctrl-C the proxy. It
   prints how many frames it recorded and dropped — a suspiciously small
   count means the app never came through the proxy, so redo the run.
   - If the app connects straight back to the real host instead of the
     proxy, it did not observe the pid.json swap: macOS FSEvents coalesces
     and can drop the create event for a rename-replace (documented at
     `clients/desktop/src/electron-main/host/host-lifecycle.ts`,
     `reloadSnapshotFromDisk`). Relaunching the app again forces a re-read.
5. Re-run with `--out recordings/task-flow.jsonl` and, in the app, create a
   task, start an agent, send one message, watch output, then Ctrl-C. This
   one is a warm session on purpose, so no relaunch is needed.
6. Scrub before committing a fixture (see Scrubbing).

## Scrubbing
Run the scrub entry over each raw recording, then review the output by eye for
any residual secrets before committing it under `fixtures/`:
`bun run src/scrub-cli.ts --in recordings/boot.jsonl --out fixtures/boot.scrubbed.jsonl`

What the scrubber redacts is defined once in `src/secret-rule.ts` and enforced
by the committed-fixture guard (`src/__tests__/fixtures.test.ts`): string
values under a `token` or `apiKey` key (case-insensitive), including inside
arrays. Objects under those keys are descended into instead, because both
names double as structured non-secrets on the real wire — `token: { vars: [...] }`
lists credential ENV VAR NAMES and `apiKey: { supported, configured, source }`
is key state, neither of which is a credential.

**Manual review item — `providers.setEnvOverride`.** Its request is
`{ providerId, key, value }` (protocol `src/host/provider-schemas.ts`), where
`key` NAMES the env var and `value` carries whatever the user pasted — an API
key or an OAuth token — under a key name no rule can recognise. It is NOT
auto-redacted. Grep any capture that touched provider settings for
`setEnvOverride` and redact the `value` by hand before committing.

## Safety
- `recordings/` is gitignored. Never commit raw recordings.
- The proxy restores the original pid.json on Ctrl-C; if it crashes, restart
  `make dev-desktop` to regenerate a clean pid.json.
- If pid.json no longer holds what the proxy wrote (the host restarted
  mid-capture and republished itself on a new port), the restore is skipped
  and a line is printed to stderr — the newer file is left alone rather than
  overwritten with stale pre-capture metadata.
- Restoring pid.json is the first thing that happens on every exit path
  (Ctrl-C, `SIGTERM`, or a crash) — the proxy is stopped and the recording is
  closed afterward, and each of those steps runs even if an earlier one
  fails. If the proxy process is killed with `SIGKILL` (which cannot be
  intercepted), pid.json is left pointing at the now-dead proxy; restart
  `make dev-desktop` to regenerate it.
