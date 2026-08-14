/**
 * The one definition of "this value is a raw credential", shared by the
 * scrubber (`scrub.ts`, which rewrites) and the committed-fixture guard
 * (`src/__tests__/fixtures.test.ts`, which asserts). They must agree
 * exactly: a guard whose rule drifted from the scrubber's stops being a
 * gate — it would either reject clean recordings or wave a leak through.
 *
 * The rule, for a value `V` under a key `K`:
 *  - `K` is a secret key and `V` is a **string** -> `V` is a credential.
 *  - `K` is a secret key and `V` is an **array** -> apply this rule to each
 *    element (an array of strings is an array of credentials — that exact
 *    class already leaked once in this package).
 *  - `K` is a secret key and `V` is a plain **object** -> `V` is NOT itself
 *    a credential; judge each child by its own key. Both secret key names
 *    double as structured non-secrets on the real wire:
 *    `token: { vars: [...] }` names credential ENV VARS
 *    (`providerLoginCapabilitySchema`, protocol
 *    `src/host/provider-schemas.ts`), and `apiKey: { supported, configured,
 *    source }` is key STATE (`providerApiKeyStateSchema`) — the raw key is
 *    never returned over RPC there.
 *  - `V` is `null`, a number, or a boolean -> not a credential, left alone.
 *    `token: null` is the common "paste-to-reconnect unsupported" value and
 *    must not be treated as an unexpected shape.
 *
 * `apiKey` is in the set because `providers.setApiKey` sends the pasted key
 * verbatim client->host (`providersSetApiKeyRequestSchema`: `apiKey:
 * z.string().min(1)`).
 *
 * `refreshToken` is in the set because the `hostCredentialProvision` frame
 * carries one verbatim client->host on the STREAM leg — one of the two legs
 * this proxy records (protocol `src/framework/stream-ws-protocol.ts:210-218`:
 * `refreshToken: z.string().min(1)`, sent by
 * `clients/shared/host-transport/ws-stream-client.ts`). It is the
 * highest-value secret on the wire: a refresh credential mints new access
 * tokens, so a leaked one outlives the access token beside it.
 *
 * NOT covered, by design: `providers.setEnvOverride` sends `{ providerId,
 * key, value }` where `key` NAMES the env var and `value` carries the raw
 * credential under a generic key name no rule can recognise. That stays a
 * manual review item before committing any fixture (see README).
 */
export const REDACTION_SENTINEL = "<redacted-token>";

const SECRET_KEYS: ReadonlySet<string> = new Set([
  "token",
  "apikey",
  "refreshtoken",
]);

/** True when a value directly under this key name may be a raw credential. Compared case-insensitively. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase());
}

/**
 * Belt-and-braces companion to the walk below, matching the plain
 * `"token":"..."` form on a frame's SERIALIZED text. Built from the same key
 * set so it cannot drift out of step with `isSecretKey` — a hand-maintained
 * copy of these names in the fixture guard is exactly the drift this module
 * exists to prevent.
 *
 * Both ends of the key are anchored (`"<name>":"`), so alternation order is
 * irrelevant and a key that merely CONTAINS a secret name is not matched:
 * `"refreshToken":"` is matched by the `refreshtoken` alternative, never by
 * `token` (there is no quote before `token` there), and `"tokenHint":"` is
 * matched by neither.
 *
 * It cannot see credentials inside arrays (those serialize with a `[`) — the
 * walk is the thorough check; this is the cheap independent one.
 */
export const UNREDACTED_SECRET_JSON_PATTERN = new RegExp(
  `"(?:${[...SECRET_KEYS].join("|")})":"(?!${REDACTION_SENTINEL})`,
  "i",
);

/**
 * Asserts a value found under a secret-named key carries no unredacted
 * credential, per the rule documented above. Throws on the first violation.
 */
function assertSecretValueRedacted(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (value !== REDACTION_SENTINEL) {
      throw new Error(
        `unredacted secret string at ${path}: ${JSON.stringify(value)}`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSecretValueRedacted(item, `${path}[${index}]`),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    // Structured non-secret (`token: { vars }`, `apiKey: { supported, ... }`):
    // not a credential itself, so each child is judged by its own key.
    assertNoResidualSecrets(value, path);
    return;
  }
  // null / number / boolean: cannot carry a credential.
}

/**
 * Recursively walks a parsed frame, checking every value found under a
 * secret-named key. Mirrors `scrubValue`'s traversal so the guard sees the
 * same structure the scrubber rewrote.
 */
export function assertNoResidualSecrets(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoResidualSecrets(item, `${path}[${index}]`),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path.length > 0 ? `${path}.${key}` : key;
      if (isSecretKey(key)) {
        assertSecretValueRedacted(child, childPath);
      } else {
        assertNoResidualSecrets(child, childPath);
      }
    }
  }
}
