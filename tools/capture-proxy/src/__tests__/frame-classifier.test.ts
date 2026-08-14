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

  it("classifies a valid host response frame (h2c direction)", () => {
    const raw = JSON.stringify({
      kind: "response",
      requestId: "r1",
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      result: {},
      error: null,
    });
    const { frame, valid } = classifyFrame({
      raw,
      connId: "c1",
      leg: "rpc",
      direction: "h2c",
      ts: 7,
    });
    expect(valid).toBe(true);
    expect(frame.direction).toBe("h2c");
    expect(frame.kind).toBe("response");
    expect(frame.method).toBe("host.status");
    expect(frame.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(frame.payload).toEqual({
      kind: "response",
      requestId: "r1",
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      result: {},
      error: null,
    });
  });

  it("records client-shaped frame sent as h2c (schema mismatch) without throwing", () => {
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
      direction: "h2c",
      ts: 8,
    });
    expect(valid).toBe(false);
    expect(frame.direction).toBe("h2c");
    expect(frame.kind).toBe("request");
    expect(frame.payload).toEqual({
      kind: "request",
      requestId: "r1",
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      params: {},
    });
  });

  it("handles JSON null (not an object)", () => {
    const raw = "null";
    const { frame, valid } = classifyFrame({
      raw,
      connId: "c1",
      leg: "rpc",
      direction: "c2h",
      ts: 9,
    });
    expect(valid).toBe(false);
    expect(frame.kind).toBe("unknown");
    expect(frame.method).toBeNull();
    expect(frame.schemaVersion).toBeNull();
    expect(frame.payload).toBeNull();
  });

  it("handles JSON array (not an object)", () => {
    const raw = JSON.stringify([1, 2, 3]);
    const { frame, valid } = classifyFrame({
      raw,
      connId: "c1",
      leg: "rpc",
      direction: "c2h",
      ts: 10,
    });
    expect(valid).toBe(false);
    expect(frame.kind).toBe("unknown");
    expect(frame.method).toBeNull();
    expect(frame.schemaVersion).toBeNull();
    expect(frame.payload).toEqual([1, 2, 3]);
  });

  it("handles JSON number (not an object)", () => {
    const raw = "42";
    const { frame, valid } = classifyFrame({
      raw,
      connId: "c1",
      leg: "rpc",
      direction: "c2h",
      ts: 11,
    });
    expect(valid).toBe(false);
    expect(frame.kind).toBe("unknown");
    expect(frame.method).toBeNull();
    expect(frame.schemaVersion).toBeNull();
    expect(frame.payload).toBe(42);
  });

  it("handles object with missing kind field", () => {
    const raw = JSON.stringify({
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
      ts: 12,
    });
    expect(valid).toBe(false);
    expect(frame.kind).toBe("unknown");
    expect(frame.method).toBe("host.status");
    expect(frame.payload).toEqual({
      requestId: "r1",
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      params: {},
    });
  });

  it("handles object with non-string kind", () => {
    const raw = JSON.stringify({
      kind: 123,
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
      ts: 13,
    });
    expect(valid).toBe(false);
    expect(frame.kind).toBe("unknown");
    expect(frame.method).toBe("host.status");
    expect(frame.payload).toEqual({
      kind: 123,
      requestId: "r1",
      method: "host.status",
      schemaVersion: { major: 1, minor: 0 },
      params: {},
    });
  });

  it("handles missing schemaVersion", () => {
    const raw = JSON.stringify({
      kind: "request",
      requestId: "r1",
      method: "host.status",
      params: {},
    });
    const { frame, valid } = classifyFrame({
      raw,
      connId: "c1",
      leg: "rpc",
      direction: "c2h",
      ts: 14,
    });
    expect(valid).toBe(false);
    expect(frame.kind).toBe("request");
    expect(frame.method).toBe("host.status");
    expect(frame.schemaVersion).toBeNull();
    expect(frame.payload).toEqual({
      kind: "request",
      requestId: "r1",
      method: "host.status",
      params: {},
    });
  });

  it("handles partial schemaVersion (missing minor)", () => {
    const raw = JSON.stringify({
      kind: "request",
      requestId: "r1",
      method: "host.status",
      schemaVersion: { major: 1 },
      params: {},
    });
    const { frame, valid } = classifyFrame({
      raw,
      connId: "c1",
      leg: "rpc",
      direction: "c2h",
      ts: 15,
    });
    expect(valid).toBe(false);
    expect(frame.schemaVersion).toBeNull();
    expect(frame.payload).toEqual({
      kind: "request",
      requestId: "r1",
      method: "host.status",
      schemaVersion: { major: 1 },
      params: {},
    });
  });

  it("handles schemaVersion with non-numeric fields", () => {
    const raw = JSON.stringify({
      kind: "request",
      requestId: "r1",
      method: "host.status",
      schemaVersion: { major: "1", minor: 0 },
      params: {},
    });
    const { frame, valid } = classifyFrame({
      raw,
      connId: "c1",
      leg: "rpc",
      direction: "c2h",
      ts: 16,
    });
    expect(valid).toBe(false);
    expect(frame.schemaVersion).toBeNull();
    expect(frame.payload).toEqual({
      kind: "request",
      requestId: "r1",
      method: "host.status",
      schemaVersion: { major: "1", minor: 0 },
      params: {},
    });
  });

  it("handles missing method field", () => {
    const raw = JSON.stringify({
      kind: "request",
      requestId: "r1",
      schemaVersion: { major: 1, minor: 0 },
      params: {},
    });
    const { frame, valid } = classifyFrame({
      raw,
      connId: "c1",
      leg: "rpc",
      direction: "c2h",
      ts: 17,
    });
    expect(valid).toBe(false);
    expect(frame.kind).toBe("request");
    expect(frame.method).toBeNull();
    expect(frame.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(frame.payload).toEqual({
      kind: "request",
      requestId: "r1",
      schemaVersion: { major: 1, minor: 0 },
      params: {},
    });
  });

  it("handles method field that is not a string", () => {
    const raw = JSON.stringify({
      kind: "request",
      requestId: "r1",
      method: 123,
      schemaVersion: { major: 1, minor: 0 },
      params: {},
    });
    const { frame, valid } = classifyFrame({
      raw,
      connId: "c1",
      leg: "rpc",
      direction: "c2h",
      ts: 18,
    });
    expect(valid).toBe(false);
    expect(frame.kind).toBe("request");
    expect(frame.method).toBeNull();
    expect(frame.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(frame.payload).toEqual({
      kind: "request",
      requestId: "r1",
      method: 123,
      schemaVersion: { major: 1, minor: 0 },
      params: {},
    });
  });
});
