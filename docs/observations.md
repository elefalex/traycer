# Observations

Passive log of noteworthy things encountered while working in this codebase.
Captured during routine tasks; triaged in dedicated cleanup passes.

**Verify before fixing.** Each row was flagged with partial context — confirm the
issue is real before acting on it. The `V` column tracks human verification.

**Lifecycle:** ☐ → ☑ for `V` (verified) and `R` (resolved). Strike resolved rows.
Append-only — never reorder or delete.

**Categories:** `todo` `dead` `bug` `smell` `stale` · **Severity:** `P0` `P1` `P2`

| Date | Cat | Sev | File:Line | Hash | V | R | Observation |
|------|-----|-----|-----------|------|---|---|-------------|
| 2026-08-14 | stale | P2 | docs/DEVELOPMENT.md:41 | `6afe6b01` | ☐ | ☐ | Docs reference an unsigned side-load flag `--allow-empty-pubkeys` that no longer exists; neither `set-deploy-target.cjs` accepts it. The trust root is now committed in `clients/traycer-cli/src/config.ts`; the surviving dogfood flag is `--allow-unpinned-host`, and the real unsigned side-load path is `traycer host install --from <dir>` (sha256-only, no minisign). |
| 2026-08-14 | bug | P0 | tools/capture-proxy/src/scrub.ts:10 | `d6fabb69` | ☐ | ☑ | ~~`scrubValue`'s array branch recurses with a hardcoded `keyName=""` instead of the parent key, so `{token: ["secret-jwt-1"]}` (a token whose value IS an array of strings) is never redacted — the array elements leak verbatim into scrubbed recordings. No test in `scrub.test.ts` exercises a `token` key whose direct value is an array; the "nested-in-arrays" test only nests token inside an object that happens to sit inside an array.~~ Fixed in `c3a123e3` (parent `keyName` threaded through array recursion) with three regression tests; leak payload verified redacted at every depth. |
| 2026-08-14 | bug | P1 | tools/capture-proxy/src/scrub.ts:5-7 | `d6fabb69` | ☐ | ☐ | The "is this key named token" check only runs inside the `typeof value === "string"` branch, so a non-string token value (`{token: 12345}` or `{token: {value: "jwt"}}`) is never redacted — it round-trips unchanged. Matches the brief's literal wording ("any string value under a key named token"), so spec-faithful, but worth a residual-risk note for a capture harness whose whole purpose is secret redaction. |
| 2026-08-14 | smell | P2 | tools/capture-proxy/src/scrub.ts:34-38 | `d6fabb69` | ☐ | ☐ | `scrubRecording` reads the whole input file into memory, computes the full scrubbed output string, and writes it in one `writeFile` call with no temp-file+rename. A malformed JSONL line throws mid-`.map()` with no line number in the error; a large recording is fully buffered twice (in + out). Not a leak (writes are all-or-nothing and post-scrub), but worth hardening before this feeds a CLI operators run on arbitrary captures. |
