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
- Restoring pid.json is the first thing that happens on every exit path
  (Ctrl-C, `SIGTERM`, or a crash) — the proxy is stopped and the recording is
  closed afterward, and each of those steps runs even if an earlier one
  fails. If the proxy process is killed with `SIGKILL` (which cannot be
  intercepted), pid.json is left pointing at the now-dead proxy; restart
  `make dev-desktop` to regenerate it.
