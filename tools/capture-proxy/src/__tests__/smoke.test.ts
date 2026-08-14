import { describe, expect, it } from "vitest";
import { clientFrameSchema } from "@traycer/protocol/framework/ws-protocol";

describe("capture-proxy scaffold", () => {
  it("resolves the protocol frame schema from source", () => {
    const parsed = clientFrameSchema.safeParse({
      kind: "request",
      requestId: "r1",
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      params: {},
    });
    expect(parsed.success).toBe(true);
  });
});
