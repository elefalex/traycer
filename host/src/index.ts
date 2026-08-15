/**
 * @traycer/open-host — the fork's open-source replacement for the proprietary
 * Traycer host. The daemon entrypoint is `main.ts`; this file exists so the
 * package resolves and to hold constants (like `OPEN_HOST_VERSION` below)
 * shared across modules.
 */
export const OPEN_HOST_NAME = "@traycer/open-host";

/**
 * Advertised in `pid.json`'s `version` field (`PidMetadata.version`,
 * `bootstrap/pid-file.ts`). Kept independent of `package.json`'s private
 * `"0.0.0"` placeholder (host/package.json:4) so bumping this is a deliberate
 * act rather than a side effect of a package-manager version bump.
 */
export const OPEN_HOST_VERSION = "0.1.0";
