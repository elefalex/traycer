import { describe, expect, it, vi } from "vitest";
import { createShutdownHandler } from "../shutdown";

describe("createShutdownHandler", () => {
  it("runs restore, then stop, then close, in that order", async () => {
    const order: string[] = [];
    const shutdown = createShutdownHandler({
      restore: async () => {
        order.push("restore");
      },
      stop: async () => {
        order.push("stop");
      },
      close: async () => {
        order.push("close");
      },
      onStepError: () => {},
    });

    await shutdown();

    expect(order).toEqual(["restore", "stop", "close"]);
  });

  it("is idempotent: concurrent and sequential calls each perform every step exactly once", async () => {
    const restore = vi.fn(async (): Promise<void> => {});
    const stop = vi.fn(async (): Promise<void> => {});
    const close = vi.fn(async (): Promise<void> => {});
    const shutdown = createShutdownHandler({
      restore,
      stop,
      close,
      onStepError: () => {},
    });

    // Two "signals" arriving back to back before the first run settles.
    await Promise.all([shutdown(), shutdown()]);
    // A third call after the run has already completed.
    await shutdown();

    expect(restore).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("still runs close (and reports the error) when stop() throws, after restore already happened", async () => {
    const order: string[] = [];
    const stopError = new Error("stop failed");
    const errors: Array<{ step: string; error: unknown }> = [];
    const shutdown = createShutdownHandler({
      restore: async () => {
        order.push("restore");
      },
      stop: async () => {
        order.push("stop");
        throw stopError;
      },
      close: async () => {
        order.push("close");
      },
      onStepError: (step, error) => {
        errors.push({ step, error });
      },
    });

    await expect(shutdown()).resolves.toBeUndefined();

    expect(order).toEqual(["restore", "stop", "close"]);
    expect(errors).toEqual([{ step: "stop", error: stopError }]);
  });

  it("still runs stop and close (and reports the error) when restore() throws", async () => {
    const order: string[] = [];
    const restoreError = new Error("restore failed");
    const errors: Array<{ step: string; error: unknown }> = [];
    const shutdown = createShutdownHandler({
      restore: async () => {
        order.push("restore");
        throw restoreError;
      },
      stop: async () => {
        order.push("stop");
      },
      close: async () => {
        order.push("close");
      },
      onStepError: (step, error) => {
        errors.push({ step, error });
      },
    });

    await expect(shutdown()).resolves.toBeUndefined();

    expect(order).toEqual(["restore", "stop", "close"]);
    expect(errors).toEqual([{ step: "restore", error: restoreError }]);
  });

  it("still runs restore and stop (and reports the error) when close() throws", async () => {
    const order: string[] = [];
    const closeError = new Error("close failed");
    const errors: Array<{ step: string; error: unknown }> = [];
    const shutdown = createShutdownHandler({
      restore: async () => {
        order.push("restore");
      },
      stop: async () => {
        order.push("stop");
      },
      close: async () => {
        order.push("close");
        throw closeError;
      },
      onStepError: (step, error) => {
        errors.push({ step, error });
      },
    });

    await expect(shutdown()).resolves.toBeUndefined();

    expect(order).toEqual(["restore", "stop", "close"]);
    expect(errors).toEqual([{ step: "close", error: closeError }]);
  });
});
