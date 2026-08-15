import { describe, expect, it, vi } from "vitest";
import { createDispatcher, type MethodTable } from "../rpc/dispatcher";

const REQUEST = JSON.stringify({
  kind: "request",
  requestId: "r-1",
  method: "host.status",
  schemaVersion: { major: 1, minor: 1 },
  params: {},
});

describe("dispatcher", () => {
  it("routes to a handler and wraps the result in a response frame", async () => {
    const table: MethodTable = new Map([
      ["host.status", async () => ({ ready: true })],
    ]);
    const raw = await createDispatcher(table)(REQUEST);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({
      kind: "response",
      requestId: "r-1",
      method: "host.status",
      schemaVersion: { major: 1, minor: 1 },
      result: { ready: true },
      error: null,
    });
  });

  it("returns a well-formed error for an unimplemented method", async () => {
    const raw = await createDispatcher(new Map())(REQUEST);
    const frame = JSON.parse(raw as string) as {
      readonly result: unknown;
      readonly error: { readonly code: string; readonly message: string };
    };
    expect(frame.result).toBeNull();
    expect(frame.error.code).toBe("RPC_ERROR");
    expect(frame.error.message).toContain("host.status");
  });

  it("logs an unimplemented method loudly - the log is the backlog", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await createDispatcher(new Map())(REQUEST);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("host.status");
    warn.mockRestore();
  });

  it("converts a throwing handler into an error frame, never a crash", async () => {
    const table: MethodTable = new Map([
      [
        "host.status",
        async () => {
          throw new Error("boom");
        },
      ],
    ]);
    const frame = JSON.parse(
      (await createDispatcher(table)(REQUEST)) as string,
    ) as { readonly error: { readonly message: string } };
    expect(frame.error.message).toContain("boom");
  });

  it("drops an unparseable frame without replying and without throwing", async () => {
    await expect(createDispatcher(new Map())("{not json")).resolves.toBeNull();
  });

  it("drops a structurally invalid frame without replying", async () => {
    await expect(
      createDispatcher(new Map())(JSON.stringify({ kind: "request" })),
    ).resolves.toBeNull();
  });

  it("echoes the requested schemaVersion back, not the canonical one", async () => {
    const table: MethodTable = new Map([["host.status", async () => ({})]]);
    const older = JSON.stringify({
      kind: "request",
      requestId: "r-2",
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      params: {},
    });
    const frame = JSON.parse(
      (await createDispatcher(table)(older)) as string,
    ) as {
      readonly schemaVersion: unknown;
    };
    expect(frame.schemaVersion).toEqual({ major: 1, minor: 0 });
  });
});
