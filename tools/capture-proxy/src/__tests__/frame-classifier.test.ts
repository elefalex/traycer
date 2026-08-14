import { describe, expect, it } from "vitest";
import { classifyFrame } from "../frame-classifier";

describe("classifyFrame", () => {
  it("classifies a valid client request frame", () => {
    const raw = JSON.stringify({
      kind: "request",
      requestId: "r1",
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      params: {},
    });
    const { frame, valid } = classifyFrame({
      raw,
      connId: "c1",
      leg: "rpc",
      direction: "c2h",
      ts: 5,
    });
    expect(valid).toBe(true);
    expect(frame.kind).toBe("request");
    expect(frame.method).toBe("host.status");
    expect(frame.schemaVersion).toEqual({ major: 1, minor: 0 });
  });

  it("records unparseable text without throwing", () => {
    const { frame, valid } = classifyFrame({
      raw: "not json",
      connId: "c1",
      leg: "rpc",
      direction: "c2h",
      ts: 6,
    });
    expect(valid).toBe(false);
    expect(frame.kind).toBe("unparseable");
    expect(frame.method).toBeNull();
  });
});
