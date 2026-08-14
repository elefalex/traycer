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
   prints how many frames it wrote to the recording — a suspiciously small
   count means the app never came through the proxy, so redo the run. It also
   prints a WARNING if any **stream** connection lost the upstream host while
   the app was still connected: that capture is truncated (the host restarted
   or crashed mid-run) and should be redone rather than committed. The rpc leg
   is not counted — it is one socket per unary request, so the host closing
   after it answers is the normal end of every successful call; a truncated
   rpc call shows up in the recording as a request with no matching response.
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
values under a `token`, `apiKey` or `refreshToken` key (case-insensitive),
including inside arrays. `refreshToken` is there because the stream leg's
`hostCredentialProvision` frame carries a raw refresh credential. Objects
under those keys are descended into instead, because `token` and `apiKey`
double as structured non-secrets on the real wire — `token: { vars: [...] }`
lists credential ENV VAR NAMES and `apiKey: { supported, configured, source }`
is key state, neither of which is a credential.

Three further rules are **value-based** — they apply to every string the walk
reaches, whatever its key, because the identifying data they remove turns up in
free text and in fields no key rule would think to name:

| Rule             | Becomes                | Why it exists                                                                                                                                           |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| home directory   | `<home>`               | the operator's username is in every absolute path                                                                                                       |
| `<home>/…` paths | `<home>/<workspace-N>` | private project names (clients, products) sit in workspace paths; the alias is stable within a recording so two frames naming one workspace still match |
| email addresses  | `<redacted-email>`     | a live capture carried the operator's address 117 times, under `email` and `createdBy`                                                                  |

Workspace numbering is per-recording — `<workspace-1>` in `boot.scrubbed.jsonl`
and in `task-flow.scrubbed.jsonl` are unrelated. The alias keys on the whole
matched path, so a workspace and a directory inside it get different
placeholders; reconstructing which prefix is "the workspace root" would be
guesswork over a tree this tool never sees, and guessing wrong republishes the
name.

The email guard reports a JSON path and withholds the value: printing the
offending frame would write the address into a CI log, republishing the very
thing the gate exists to withhold.

**Binary frames are never scrubbed, because their content is never recorded.**
The stream leg pairs a text envelope (`hasBinaryPayload: true`) with a binary
frame carrying the payload. The proxy forwards those bytes byte-exact but
records only `{"kind":"binary", ..., "payload":{"byteLength":N}}` — no content,
in any encoding. Binary bytes are opaque to the scrubber and to the fixture
guard, so recording them would carry un-scrubbable bytes past the last gate
before a public fork.

**Manual review item — `providers.setEnvOverride`.** Its request is
`{ providerId, key, value }` (protocol `src/host/provider-schemas.ts`), where
`key` NAMES the env var and `value` carries whatever the user pasted — an API
key or an OAuth token — under a key name no rule can recognise. It is NOT
auto-redacted. Grep any capture that touched provider settings for
`setEnvOverride` and redact the `value` by hand before committing.

**Manual review item — directory names containing a space or a quote.** The
workspace pattern stops at the first such character, so the tail of the path
survives with no `<home>/` prefix left for the guard to catch. Nothing in a
normal capture produces one, but a workspace named `~/My Projects/acme` would
leave `Projects/acme` in the fixture.

**Run the sweep yourself before committing a fixture.** The guard enforces the
rules above; it cannot enforce the ones nobody has written yet. Both times a
class of secret slipped through on this project, an independent grep found it
and the green test run did not:

```sh
cd fixtures
grep -cE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' *.jsonl   # emails
grep -c 'eyJ' *.jsonl                                                # JWT-ish
grep -c "$(whoami)" *.jsonl                                          # username
grep -coE '<home>/[a-zA-Z0-9._]' *.jsonl                             # unaliased paths
```

Every count must be `0`.

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
