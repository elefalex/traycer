import { describe, expect, it } from "vitest";
import {
  assertNoResidualSecrets,
  isSecretKey,
  REDACTION_SENTINEL,
} from "../secret-rule";
import { scrubFrame } from "../scrub";
import type { RecordedFrame } from "../recorder";

const base: RecordedFrame = {
  ts: 1,
  connId: "c1",
  leg: "rpc",
  direction: "c2h",
  kind: "request",
  method: null,
  schemaVersion: null,
  payload: {},
};

function guard(payload: unknown): () => void {
  return () => assertNoResidualSecrets(payload, "");
}

function scrubbedPayload(payload: unknown): Record<string, unknown> {
  return scrubFrame({ ...base, payload }, "/Users/alex").payload as Record<
    string,
    unknown
  >;
}

describe("isSecretKey", () => {
  it("matches token and apiKey case-insensitively", () => {
    expect(isSecretKey("token")).toBe(true);
    expect(isSecretKey("Token")).toBe(true);
    expect(isSecretKey("TOKEN")).toBe(true);
    expect(isSecretKey("apiKey")).toBe(true);
    expect(isSecretKey("apikey")).toBe(true);
    expect(isSecretKey("APIKEY")).toBe(true);
  });

  it("does not match unrelated keys", () => {
    expect(isSecretKey("tokens")).toBe(false);
    expect(isSecretKey("apiKeyState")).toBe(false);
    expect(isSecretKey("method")).toBe(false);
  });
});

// Real shapes from @traycer/protocol's provider-schemas: `token` is the
// credential env-var NAME list on providerLoginCapabilitySchema, and
// `apiKey` is providerApiKeyStateSchema. Both are clean data that appears in
// genuine captures, and both must survive the round trip untouched.
describe("structured non-secrets under a secret-named key", () => {
  it("accepts token: null (paste-to-reconnect unsupported)", () => {
    expect(guard({ token: null })).not.toThrow();
    expect(scrubbedPayload({ token: null }).token).toBe(null);
  });

  it("accepts token: { vars: [...] } and leaves the env-var names intact", () => {
    const payload = {
      token: { vars: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] },
    };
    expect(guard(payload)).not.toThrow();
    expect(scrubbedPayload(payload)).toEqual(payload);
  });

  it("accepts apiKey: { supported, configured, source } unchanged", () => {
    const payload = {
      apiKey: { supported: true, configured: false, source: "env" },
    };
    expect(guard(payload)).not.toThrow();
    expect(scrubbedPayload(payload)).toEqual(payload);
  });

  it("accepts a full providerCliState-shaped frame", () => {
    const payload = {
      kind: "response",
      result: {
        state: {
          providerId: "cursor",
          loginCapability: {
            oauthArgs: null,
            token: { vars: ["CURSOR_API_KEY"] },
            codePaste: null,
            terminalLogin: null,
          },
          apiKey: { supported: true, configured: true, source: "stored" },
        },
      },
    };
    expect(guard(payload)).not.toThrow();
    expect(scrubbedPayload(payload)).toEqual(payload);
  });

  it("still catches a raw credential nested under a structured secret-named key", () => {
    // `token` is an object here (so not itself a secret), but its `apiKey`
    // child is judged by its own key and is a raw string.
    expect(guard({ token: { vars: [], apiKey: "sk-ant-leaked" } })).toThrow(
      /unredacted secret string at token\.apiKey/,
    );
  });

  it("leaves numbers and booleans under a secret-named key alone", () => {
    expect(guard({ token: 0, apiKey: false })).not.toThrow();
  });
});

describe("raw credentials under a secret-named key", () => {
  it("redacts a string apiKey (providers.setApiKey carries the pasted key verbatim)", () => {
    const scrubbed = scrubbedPayload({
      providerId: "cursor",
      apiKey: "sk-ant-xxx",
    });
    expect(scrubbed.apiKey).toBe(REDACTION_SENTINEL);
    expect(JSON.stringify(scrubbed)).not.toContain("sk-ant-xxx");
    expect(guard(scrubbed)).not.toThrow();
  });

  it("fails the guard on an unredacted string apiKey", () => {
    expect(guard({ apiKey: "sk-ant-xxx" })).toThrow(
      /unredacted secret string at apiKey/,
    );
  });

  it("redacts every element of an array apiKey", () => {
    const scrubbed = scrubbedPayload({ apiKey: ["sk-1", "sk-2"] });
    expect(scrubbed.apiKey).toEqual([REDACTION_SENTINEL, REDACTION_SENTINEL]);
    expect(JSON.stringify(scrubbed)).not.toContain("sk-1");
    expect(guard(scrubbed)).not.toThrow();
  });

  it("fails the guard on an unredacted array apiKey", () => {
    expect(guard({ apiKey: ["sk-1", "sk-2"] })).toThrow(
      /unredacted secret string at apiKey\[0\]/,
    );
  });

  it("redacts a string apiKey nested deep in arrays and objects", () => {
    const scrubbed = scrubbedPayload({
      params: [{ providers: { APIKEY: "sk-deep" } }],
    });
    expect(JSON.stringify(scrubbed)).not.toContain("sk-deep");
    expect(guard(scrubbed)).not.toThrow();
  });

  it("keeps redacting string tokens", () => {
    expect(scrubbedPayload({ token: "bearer-jwt" }).token).toBe(
      REDACTION_SENTINEL,
    );
    expect(guard({ token: "bearer-jwt" })).toThrow(
      /unredacted secret string at token/,
    );
  });
});
