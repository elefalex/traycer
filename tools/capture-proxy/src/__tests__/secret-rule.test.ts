import { describe, expect, it } from "vitest";
import {
  assertNoResidualSecrets,
  isSecretKey,
  REDACTION_SENTINEL,
  UNREDACTED_SECRET_JSON_PATTERN,
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

  it("matches refreshToken case-insensitively", () => {
    expect(isSecretKey("refreshToken")).toBe(true);
    expect(isSecretKey("refreshtoken")).toBe(true);
    expect(isSecretKey("REFRESHTOKEN")).toBe(true);
  });

  it("does not match unrelated keys", () => {
    expect(isSecretKey("tokens")).toBe(false);
    expect(isSecretKey("apiKeyState")).toBe(false);
    expect(isSecretKey("refreshTokenState")).toBe(false);
    expect(isSecretKey("method")).toBe(false);
  });
});

// The serialized-form pattern is the belt to the walker's braces in the
// committed-fixture guard. It lives beside the key set so the two cannot
// drift, and it is asserted here because the guard that consumes it
// self-skips whenever `fixtures/` is empty.
describe("UNREDACTED_SECRET_JSON_PATTERN", () => {
  it("matches every secret key name carrying a raw string value", () => {
    expect('{"token":"bearer-jwt"}').toMatch(UNREDACTED_SECRET_JSON_PATTERN);
    expect('{"apiKey":"sk-ant-xxx"}').toMatch(UNREDACTED_SECRET_JSON_PATTERN);
    expect('{"refreshToken":"eyJhbGciOiJkaXIifQ..iv.ct.tag"}').toMatch(
      UNREDACTED_SECRET_JSON_PATTERN,
    );
  });

  it("does not match once the value is the redaction sentinel", () => {
    expect(`{"token":"${REDACTION_SENTINEL}"}`).not.toMatch(
      UNREDACTED_SECRET_JSON_PATTERN,
    );
    expect(`{"refreshToken":"${REDACTION_SENTINEL}"}`).not.toMatch(
      UNREDACTED_SECRET_JSON_PATTERN,
    );
  });

  it("does not match a key that merely contains a secret key name", () => {
    // Both ends of the key are anchored (`"<name>":"`), so `refreshToken`
    // containing `token` cannot be matched by the `token` alternative, and a
    // longer key such as `tokenHint` is not a secret key at all.
    expect('{"tokenHint":"not-a-credential"}').not.toMatch(
      UNREDACTED_SECRET_JSON_PATTERN,
    );
    expect('{"refreshTokenState":"issued"}').not.toMatch(
      UNREDACTED_SECRET_JSON_PATTERN,
    );
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

  // hostCredentialProvision (protocol
  // src/framework/stream-ws-protocol.ts:210-218) puts a refresh credential on
  // the stream leg, which this proxy records. It is the highest-value secret
  // on the wire: a refresh token mints new access tokens.
  it("redacts a string refreshToken", () => {
    const jwe =
      "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..aXYxMjM.Y2lwaGVy.dGFn";
    const scrubbed = scrubbedPayload({ refreshToken: jwe });
    expect(scrubbed.refreshToken).toBe(REDACTION_SENTINEL);
    expect(JSON.stringify(scrubbed)).not.toContain(jwe);
    expect(guard(scrubbed)).not.toThrow();
  });

  it("fails the guard on an unredacted string refreshToken", () => {
    expect(
      guard({
        refreshToken:
          "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..aXYxMjM.Y2lwaGVy.dGFn",
      }),
    ).toThrow(/unredacted secret string at refreshToken/);
  });

  it("redacts both credentials of a hostCredentialProvision frame and keeps familyId", () => {
    const payload = {
      kind: "hostCredentialProvision",
      token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2ln",
      refreshToken:
        "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..aXYxMjM.Y2lwaGVy.dGFn",
      familyId: "fam_01HZY8Q3K7",
      provisionedAt: "2026-08-14T09:30:00.000Z",
    };
    const scrubbed = scrubbedPayload(payload);

    expect(scrubbed.token).toBe(REDACTION_SENTINEL);
    expect(scrubbed.refreshToken).toBe(REDACTION_SENTINEL);
    // familyId identifies a credential family, not a credential: it must
    // survive so the recording still shows how provisioning is sequenced.
    expect(scrubbed.familyId).toBe("fam_01HZY8Q3K7");
    expect(scrubbed.provisionedAt).toBe("2026-08-14T09:30:00.000Z");
    expect(JSON.stringify(scrubbed)).not.toContain("Y2lwaGVy");
    expect(JSON.stringify(scrubbed)).not.toContain("c2ln");
    expect(guard(scrubbed)).not.toThrow();
    expect(JSON.stringify(scrubbed)).not.toMatch(
      UNREDACTED_SECRET_JSON_PATTERN,
    );

    expect(guard(payload)).toThrow(/unredacted secret string at token/);
    expect(JSON.stringify(payload)).toMatch(UNREDACTED_SECRET_JSON_PATTERN);
  });
});
