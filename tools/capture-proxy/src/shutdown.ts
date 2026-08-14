type ShutdownStep = "restore" | "stop" | "close";

export type ShutdownDeps = {
  readonly restore: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly onStepError: (step: ShutdownStep, error: unknown) => void;
};

export type ShutdownHandler = () => Promise<void>;

async function runStep(
  step: ShutdownStep,
  run: () => Promise<void>,
  onStepError: (step: ShutdownStep, error: unknown) => void,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    onStepError(step, error);
  }
}

/**
 * Builds the process shutdown routine: restore pid.json first (the
 * destructive-if-skipped step — it is what points the desktop app back at
 * the real host), then stop the proxy, then close the recorder.
 *
 * Each step runs independently: a throwing `stop` must not prevent `close`
 * from running, and vice versa. The returned handler is idempotent — the
 * sequence is started at most once, and every caller (including concurrent
 * ones, e.g. two signals arriving back to back) awaits that same run rather
 * than re-executing any step.
 */
export function createShutdownHandler(deps: ShutdownDeps): ShutdownHandler {
  let run: Promise<void> | null = null;
  return (): Promise<void> => {
    if (run === null) {
      run = (async (): Promise<void> => {
        await runStep("restore", deps.restore, deps.onStepError);
        await runStep("stop", deps.stop, deps.onStepError);
        await runStep("close", deps.close, deps.onStepError);
      })();
    }
    return run;
  };
}
