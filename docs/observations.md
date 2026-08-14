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
