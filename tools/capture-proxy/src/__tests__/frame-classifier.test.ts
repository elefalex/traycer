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

  // The /stream leg is a different wire contract from /rpc, and judging it by
  // the /rpc envelope produced 224 bogus "frame rejected" warnings in a live
  // capture - every one of them on leg=stream, none on leg=rpc. The stream leg
  // is validated the way clients/shared/host-transport/ws-stream-client.ts
  // validates it: several schemas tried in turn, not one union.
  describe("stream leg", () => {
    const details = {
      code: "STREAM_PROTOCOL_ERROR",
      reason: "nope",
      incompatibleMethods: null,
      upgradeGuidance: null,
    };

    function classifyStream(
      payload: unknown,
      direction: "c2h" | "h2c",
    ): { valid: boolean; kind: string } {
      const { frame, valid } = classifyFrame({
        raw: JSON.stringify(payload),
        connId: "c1",
        leg: "stream",
        direction,
        ts: 100,
      });
      return { valid, kind: frame.kind };
    }

    // The per-method payload kinds (update, snapshot, changed, ping, pong) are
    // declared by per-stream contracts such as
    // protocol/src/host/worktree-changed-stream.ts, not by the transport, so
    // the transport envelope is all the proxy can hold them to - exactly what
    // the real stream client does.
    it.each([
      [
        "update with a paired binary payload",
        { kind: "update", hasBinaryPayload: true, seq: 4 },
      ],
      ["snapshot", { kind: "snapshot", hasBinaryPayload: false, items: [] }],
      ["pong", { kind: "pong", hasBinaryPayload: false }],
    ])(
      "accepts a host %s frame against the stream envelope",
      (_label, payload) => {
        expect(classifyStream(payload, "h2c").valid).toBe(true);
        // The same frame is not an /rpc host frame, which is why leg-blind
        // validation rejected it.
        const rpc = classifyFrame({
          raw: JSON.stringify(payload),
          connId: "c1",
          leg: "rpc",
          direction: "h2c",
          ts: 100,
        });
        expect(rpc.valid).toBe(false);
      },
    );

    it("accepts the host openAck control frame", () => {
      expect(
        classifyStream(
          {
            kind: "openAck",
            manifest: { "worktree.changed": { major: 1, minor: 0 } },
          },
          "h2c",
        ).valid,
      ).toBe(true);
    });

    it("accepts the host fatalError control frame", () => {
      expect(classifyStream({ kind: "fatalError", details }, "h2c").valid).toBe(
        true,
      );
    });

    it.each([
      ["open", { kind: "open", token: "t", manifest: {} }],
      [
        "subscribe",
        {
          kind: "subscribe",
          method: "worktree.changed",
          schemaVersion: { major: 1, minor: 0 },
          params: {},
        },
      ],
      ["credentialUpdate", { kind: "credentialUpdate", token: "t" }],
      [
        "hostCredentialProvision",
        {
          kind: "hostCredentialProvision",
          token: "t",
          refreshToken: "r",
          familyId: "f",
          provisionedAt: "2026-08-14T10:20:30.400Z",
        },
      ],
      ["fatalError", { kind: "fatalError", details }],
    ])("accepts the client %s frame", (_label, payload) => {
      expect(classifyStream(payload, "c2h").valid).toBe(true);
    });

    // The point of leg-aware validation is a narrower net, not no net: a
    // frame none of the stream schemas accept is still a finding.
    it("still rejects a host frame that matches none of the stream schemas", () => {
      // No `hasBinaryPayload`, so not an envelope; not a control kind either.
      expect(classifyStream({ kind: "update", seq: 1 }, "h2c").valid).toBe(
        false,
      );
    });

    it("still rejects a client subscribe frame missing its method", () => {
      expect(
        classifyStream(
          {
            kind: "subscribe",
            schemaVersion: { major: 1, minor: 0 },
            params: {},
          },
          "c2h",
        ).valid,
      ).toBe(false);
    });

    it("names the schema family that rejected a stream frame", () => {
      const c2h = classifyFrame({
        raw: JSON.stringify({ kind: "bogus" }),
        connId: "c1",
        leg: "stream",
        direction: "c2h",
        ts: 100,
      });
      const h2c = classifyFrame({
        raw: JSON.stringify({ kind: "bogus" }),
        connId: "c1",
        leg: "stream",
        direction: "h2c",
        ts: 100,
      });
      expect(c2h.validatedBy).toBe("clientStreamFrameSchemas");
      expect(h2c.validatedBy).toBe("hostStreamFrameSchemas");
    });

    /**
     * A live capture rejected every one of these: the envelope is documented as
     * spanning both directions, and `epic-stream-client.ts` authors exactly
     * these frames client -> host, but only the host list carried it.
     */
    it.each([
      ["applyUpdate", { kind: "applyUpdate", epicId: "e1" }],
      ["awareness", { kind: "awareness", epicId: "e1" }],
    ])("accepts a client-authored %s envelope frame", (_kind, body) => {
      const result = classifyFrame({
        raw: JSON.stringify({ ...body, hasBinaryPayload: true }),
        connId: "c1",
        leg: "stream",
        direction: "c2h",
        ts: 100,
      });
      expect(result.valid).toBe(true);
    });

    it("leaves the rpc leg naming its own schemas", () => {
      expect(
        classifyFrame({
          raw: JSON.stringify({ kind: "bogus" }),
          connId: "c1",
          leg: "rpc",
          direction: "c2h",
          ts: 100,
        }).validatedBy,
      ).toBe("clientFrameSchema");
      expect(
        classifyFrame({
          raw: JSON.stringify({ kind: "bogus" }),
          connId: "c1",
          leg: "rpc",
          direction: "h2c",
          ts: 100,
        }).validatedBy,
      ).toBe("hostFrameSchema");
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
