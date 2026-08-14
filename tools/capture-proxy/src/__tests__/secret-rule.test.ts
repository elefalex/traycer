import { describe, expect, it } from "vitest";
import {
  assertNoResidualEmails,
  assertNoResidualSecrets,
  assertNoResidualWorkspacePaths,
  createWorkspaceAliases,
  EMAIL_ADDRESS_PATTERN,
  EMAIL_REDACTION_SENTINEL,
  isSecretKey,
  redactEmailAddresses,
  redactWorkspacePaths,
  REDACTION_SENTINEL,
  UNREDACTED_SECRET_JSON_PATTERN,
  UNREDACTED_WORKSPACE_PATH_PATTERN,
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

function emailGuard(payload: unknown): () => void {
  return () => assertNoResidualEmails(payload, "");
}

function scrubbedPayload(payload: unknown): Record<string, unknown> {
  return scrubFrame(
    { ...base, payload },
    "/Users/alex",
    createWorkspaceAliases(),
  ).payload as Record<string, unknown>;
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

describe("EMAIL_ADDRESS_PATTERN", () => {
  it("matches the common local@domain.tld shapes a capture carries", () => {
    expect("someone@example.com").toMatch(EMAIL_ADDRESS_PATTERN);
    expect("first.last+tag@sub.example.co.uk").toMatch(EMAIL_ADDRESS_PATTERN);
    expect("UPPER.CASE@Example.COM").toMatch(EMAIL_ADDRESS_PATTERN);
    expect("a_b%c-d@my-host.io").toMatch(EMAIL_ADDRESS_PATTERN);
  });

  it("matches an address embedded in surrounding text", () => {
    expect("owner is someone@example.com, ping them").toMatch(
      EMAIL_ADDRESS_PATTERN,
    );
    expect("<mailto:someone@example.com>").toMatch(EMAIL_ADDRESS_PATTERN);
  });

  it("does not match `@` strings that are not addresses", () => {
    // A scoped npm package, a bare host with no TLD, a decorator and a
    // filesystem path through node_modules all carry an `@` on the real wire.
    expect("npm i @scope/pkg").not.toMatch(EMAIL_ADDRESS_PATTERN);
    expect("user@host").not.toMatch(EMAIL_ADDRESS_PATTERN);
    expect("@traycer/protocol").not.toMatch(EMAIL_ADDRESS_PATTERN);
    expect("/Users/alex/node_modules/@babel/core").not.toMatch(
      EMAIL_ADDRESS_PATTERN,
    );
    expect("build @ 2026-08-14").not.toMatch(EMAIL_ADDRESS_PATTERN);
  });

  it("does not match either redaction sentinel", () => {
    expect(EMAIL_REDACTION_SENTINEL).not.toMatch(EMAIL_ADDRESS_PATTERN);
    expect(REDACTION_SENTINEL).not.toMatch(EMAIL_ADDRESS_PATTERN);
  });

  it("is stateless across calls (no `g` flag lastIndex carry-over)", () => {
    expect(EMAIL_ADDRESS_PATTERN.test("someone@example.com")).toBe(true);
    expect(EMAIL_ADDRESS_PATTERN.test("someone@example.com")).toBe(true);
  });
});

describe("redactEmailAddresses", () => {
  it("replaces the address and nothing else", () => {
    expect(redactEmailAddresses("ask someone@example.com about it")).toBe(
      "ask <redacted-email> about it",
    );
  });

  it("replaces every address in a string, not just the first", () => {
    expect(redactEmailAddresses("a@x.com and b@y.org")).toBe(
      "<redacted-email> and <redacted-email>",
    );
  });

  it("leaves strings without an address untouched", () => {
    expect(redactEmailAddresses("npm i @scope/pkg")).toBe("npm i @scope/pkg");
  });

  it("is idempotent", () => {
    const once = redactEmailAddresses("mail someone@example.com");
    expect(redactEmailAddresses(once)).toBe(once);
  });
});

// The email guard is the fixture gate's PII half. It is value-based, so it
// checks every string it walks regardless of key name — the operator's address
// showed up under `email`, `createdBy` and deeper still in a real capture, and
// a key-name list would have missed the ones it did not enumerate.
describe("assertNoResidualEmails", () => {
  it("throws on a raw address under a plain key", () => {
    expect(emailGuard({ email: "someone@example.com" })).toThrow(
      /unredacted email address at email/,
    );
    expect(emailGuard({ createdBy: "someone@example.com" })).toThrow(
      /unredacted email address at createdBy/,
    );
  });

  it("never echoes the address it found", () => {
    // The failure text lands in CI logs, so it must not reprint the exact PII
    // this guard exists to keep out of the repository.
    expect(emailGuard({ email: "someone@example.com" })).toThrow(
      /value withheld/,
    );
    expect(emailGuard({ email: "someone@example.com" })).not.toThrow(
      /someone@example\.com/,
    );
  });

  it("throws on an address embedded in a longer string", () => {
    expect(
      emailGuard({ note: "owner is someone@example.com, ping them" }),
    ).toThrow(/unredacted email address at note/);
  });

  it("throws on an address inside an array", () => {
    expect(emailGuard({ members: ["ok", "someone@example.com"] })).toThrow(
      /unredacted email address at members\[1\]/,
    );
  });

  it("throws on an address nested several levels under non-secret keys", () => {
    expect(
      emailGuard({
        result: { profile: { contact: { primary: "someone@example.com" } } },
      }),
    ).toThrow(/unredacted email address at result\.profile\.contact\.primary/);
  });

  it("throws on an address used as an object key", () => {
    // The scrubber rewrites values, not key names, so a keyed-by-address map
    // is a fail-closed stop: the gate blocks the commit and a human decides.
    expect(
      emailGuard({ seats: { "someone@example.com": { role: "admin" } } }),
    ).toThrow(/unredacted email address in key at seats/);
  });

  it("passes once the address is the sentinel", () => {
    expect(
      emailGuard({
        email: EMAIL_REDACTION_SENTINEL,
        note: `owner is ${EMAIL_REDACTION_SENTINEL}`,
        members: [EMAIL_REDACTION_SENTINEL],
      }),
    ).not.toThrow();
  });

  // The gate's real contract: whatever the scrubber emits, the guard accepts.
  // Asserting both directions on one payload is what makes this a gate rather
  // than two rules that happen to be spelled similarly.
  it("rejects the raw payload and accepts the scrubber's output for it", () => {
    const payload = {
      email: "someone@example.com",
      note: "ping someone@example.com about /Users/alex/inbox",
      nested: { list: ["a@b.io"] },
      token: "jwt-for-someone@example.com",
    };
    expect(emailGuard(payload)).toThrow(/unredacted email address/);

    const scrubbed = scrubbedPayload(payload);
    expect(emailGuard(scrubbed)).not.toThrow();
    expect(guard(scrubbed)).not.toThrow();
    expect(JSON.stringify(scrubbed)).not.toContain("someone@example.com");
    expect(JSON.stringify(scrubbed)).not.toContain("a@b.io");
  });

  it("passes on clean non-address `@` values and non-strings", () => {
    expect(
      emailGuard({
        cmd: "npm i @scope/pkg",
        host: "user@host",
        count: 3,
        ok: true,
        nothing: null,
      }),
    ).not.toThrow();
  });
});

// The workspace rule's two halves, asserted against each other: the pattern
// the guard rejects with is built from the same sources the replacement uses,
// so a fixture the scrubber cleaned is a fixture the gate accepts.
describe("UNREDACTED_WORKSPACE_PATH_PATTERN", () => {
  it("matches a home-rooted path that still carries a segment", () => {
    expect("<home>/Projects/personal/rental-platform").toMatch(
      UNREDACTED_WORKSPACE_PATH_PATTERN,
    );
    expect("<home>/Projects/skytrack/backendcarbnb").toMatch(
      UNREDACTED_WORKSPACE_PATH_PATTERN,
    );
    expect("opened <home>/Projects/app in the editor").toMatch(
      UNREDACTED_WORKSPACE_PATH_PATTERN,
    );
  });

  it("does not match once the segments are a workspace placeholder", () => {
    expect("<home>/<workspace-1>").not.toMatch(
      UNREDACTED_WORKSPACE_PATH_PATTERN,
    );
    expect("<home>/<workspace-42> is the repo").not.toMatch(
      UNREDACTED_WORKSPACE_PATH_PATTERN,
    );
  });

  it("does not match a bare <home>, with or without a trailing slash", () => {
    expect("<home>").not.toMatch(UNREDACTED_WORKSPACE_PATH_PATTERN);
    expect("<home>/").not.toMatch(UNREDACTED_WORKSPACE_PATH_PATTERN);
    expect("cwd is <home>").not.toMatch(UNREDACTED_WORKSPACE_PATH_PATTERN);
  });

  it("does not match paths outside the home directory", () => {
    expect("/usr/local/bin/node").not.toMatch(
      UNREDACTED_WORKSPACE_PATH_PATTERN,
    );
    expect("/tmp/run-1/socket").not.toMatch(UNREDACTED_WORKSPACE_PATH_PATTERN);
  });

  it("rejects a bracketed segment that is not a workspace placeholder", () => {
    // Fail-closed: the replacement declines `<`-leading segments (it must, to
    // stay idempotent), so the gate stops and a human decides.
    expect("<home>/<workspace>").toMatch(UNREDACTED_WORKSPACE_PATH_PATTERN);
    expect("<home>/<home>").toMatch(UNREDACTED_WORKSPACE_PATH_PATTERN);
  });

  it("is stateless across calls (no `g` flag lastIndex carry-over)", () => {
    const path = "<home>/Projects/app";
    expect(UNREDACTED_WORKSPACE_PATH_PATTERN.test(path)).toBe(true);
    expect(UNREDACTED_WORKSPACE_PATH_PATTERN.test(path)).toBe(true);
  });
});

describe("redactWorkspacePaths", () => {
  it("replaces the segments and nothing else", () => {
    expect(
      redactWorkspacePaths(
        "opened <home>/Projects/personal/rental-platform now",
        createWorkspaceAliases(),
      ),
    ).toBe("opened <home>/<workspace-1> now");
  });

  it("numbers distinct paths in order of first appearance", () => {
    const aliases = createWorkspaceAliases();
    expect(redactWorkspacePaths("<home>/a", aliases)).toBe(
      "<home>/<workspace-1>",
    );
    expect(redactWorkspacePaths("<home>/b", aliases)).toBe(
      "<home>/<workspace-2>",
    );
  });

  it("reuses the placeholder for a path it has already seen", () => {
    const aliases = createWorkspaceAliases();
    expect(redactWorkspacePaths("<home>/a and <home>/b", aliases)).toBe(
      "<home>/<workspace-1> and <home>/<workspace-2>",
    );
    expect(redactWorkspacePaths("back to <home>/a", aliases)).toBe(
      "back to <home>/<workspace-1>",
    );
  });

  it("keeps separate tables separate", () => {
    // Per-recording state: a module-level table would make `<workspace-1>` in
    // one output mean whatever the previous run saw first.
    expect(redactWorkspacePaths("<home>/b", createWorkspaceAliases())).toBe(
      "<home>/<workspace-1>",
    );
    expect(redactWorkspacePaths("<home>/c", createWorkspaceAliases())).toBe(
      "<home>/<workspace-1>",
    );
  });

  it("leaves strings without a home-rooted path untouched", () => {
    const aliases = createWorkspaceAliases();
    expect(redactWorkspacePaths("<home>", aliases)).toBe("<home>");
    expect(redactWorkspacePaths("/usr/lib/node", aliases)).toBe(
      "/usr/lib/node",
    );
    expect(aliases.size).toBe(0);
  });

  it("is idempotent", () => {
    const aliases = createWorkspaceAliases();
    const once = redactWorkspacePaths("<home>/Projects/app", aliases);
    expect(redactWorkspacePaths(once, aliases)).toBe(once);
    expect(aliases.size).toBe(1);
  });
});

describe("assertNoResidualWorkspacePaths", () => {
  function workspaceGuard(payload: unknown): () => void {
    return () => assertNoResidualWorkspacePaths(payload, "");
  }

  it("throws on a residual path under a plain key", () => {
    expect(
      workspaceGuard({
        workspacePath: "<home>/Projects/personal/rental-platform",
      }),
    ).toThrow(/unredacted workspace path at workspacePath/);
  });

  it("never echoes the path it found", () => {
    // The failure text lands in CI logs, and the segment IS the private
    // project name this gate exists to withhold.
    expect(
      workspaceGuard({ cwd: "<home>/Projects/skytrack/backendcarbnb" }),
    ).toThrow(/value withheld/);
    expect(
      workspaceGuard({ cwd: "<home>/Projects/skytrack/backendcarbnb" }),
    ).not.toThrow(/skytrack/);
  });

  it("throws on a path embedded in a longer string", () => {
    expect(
      workspaceGuard({ note: "opened <home>/Projects/app in the editor" }),
    ).toThrow(/unredacted workspace path at note/);
  });

  it("throws on a path inside an array", () => {
    expect(
      workspaceGuard({
        roots: ["<home>/<workspace-1>", "<home>/Projects/app"],
      }),
    ).toThrow(/unredacted workspace path at roots\[1\]/);
  });

  it("throws on a path nested several levels under non-secret keys", () => {
    expect(
      workspaceGuard({
        result: { tasks: [{ meta: { cwd: "<home>/Projects/app" } }] },
      }),
    ).toThrow(/unredacted workspace path at result\.tasks\[0\]\.meta\.cwd/);
  });

  it("throws on a path used as an object key", () => {
    expect(
      workspaceGuard({
        byWorkspace: { "<home>/Projects/app": { open: true } },
      }),
    ).toThrow(/unredacted workspace path in key at byWorkspace/);
  });

  it("passes once the segments are the placeholder", () => {
    expect(
      workspaceGuard({
        cwd: "<home>/<workspace-1>",
        note: "opened <home>/<workspace-2>",
        roots: ["<home>/<workspace-1>"],
        home: "<home>",
      }),
    ).not.toThrow();
  });

  it("passes on paths outside the home directory and on non-strings", () => {
    expect(
      workspaceGuard({
        bin: "/usr/local/bin/node",
        count: 3,
        ok: true,
        nothing: null,
      }),
    ).not.toThrow();
  });

  // The gate's real contract, asserted in both directions on one payload:
  // whatever the scrubber emits, the guard accepts — and the raw form it was
  // built from, it rejects.
  it("rejects the raw payload and accepts the scrubber's output for it", () => {
    const payload = {
      workspacePath: "/Users/alex/Projects/personal/rental-platform",
      note: "built /Users/alex/Projects/skytrack/backendcarbnb for someone@example.com",
      nested: { roots: ["/Users/alex/Projects/personal/rental-platform"] },
      token: "jwt-for-/Users/alex/Projects/skytrack/backendcarbnb",
      home: "/Users/alex",
    };
    // The half-scrubbed form — home substituted, workspace rule not run — is
    // exactly what this rule was added to catch, and the gate rejects it.
    expect(
      workspaceGuard({
        workspacePath: "<home>/Projects/personal/rental-platform",
      }),
    ).toThrow(/unredacted workspace path/);

    const scrubbed = scrubbedPayload(payload);
    expect(workspaceGuard(scrubbed)).not.toThrow();
    expect(emailGuard(scrubbed)).not.toThrow();
    expect(guard(scrubbed)).not.toThrow();
    const stringified = JSON.stringify(scrubbed);
    expect(stringified).not.toContain("rental-platform");
    expect(stringified).not.toContain("skytrack");
    expect(stringified).not.toContain("carbnb");
    expect(scrubbed.home).toBe("<home>");
    expect(scrubbed.token).toBe(REDACTION_SENTINEL);
  });
});
