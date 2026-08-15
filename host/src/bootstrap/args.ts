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
