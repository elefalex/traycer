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
 * The second rule this module owns: personal email addresses. Same
 * anti-drift discipline as the credential rule — the scrubber rewrites with
 * `redactEmailAddresses` and the fixture guard asserts with
 * `assertNoResidualEmails`, both built from the single pattern below.
 *
 * Unlike the credential rule, this one is VALUE-based, not key-based. A live
 * capture put the operator's address under `email` and `createdBy`, and also
 * deeper inside free-text fields; any list of key names is a list of the
 * places we happened to look. The shape of the value is the reliable signal,
 * so every string the walk reaches is judged, whatever key it sits under.
 *
 * Redaction is a substring replacement, not a whole-value one: only the
 * address is swapped for the sentinel, leaving the surrounding sentence
 * intact so the recording still reads as a recording.
 */
export const EMAIL_REDACTION_SENTINEL = "<redacted-email>";

/**
 * A deliberately practical `local@domain.tld` matcher — NOT RFC 5322, which
 * permits quoted local parts, comments, and bracketed IP-literal domains that
 * no capture of ours has ever carried and whose grammar cannot be expressed
 * as one readable regex. It covers what real addresses look like:
 *
 *  - local part: letters, digits, and the usual `. _ % + -` (so
 *    `first.last+tag` is matched),
 *  - domain: one or more dot-separated labels,
 *  - a final TLD of two or more LETTERS, which is what keeps this from
 *    firing on every `@` in the capture.
 *
 * That last requirement is the whole false-positive defence: `user@host`
 * (no dot), `@scope/pkg`, `@traycer/protocol` and `.../node_modules/@babel/core`
 * (nothing address-shaped before the `@`) are all left alone.
 *
 * The trade is set intentionally towards over-matching: a false positive
 * costs one redacted string in a test fixture, a false negative publishes
 * someone's address to a public repository.
 */
const EMAIL_ADDRESS_SOURCE =
  "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}";

/**
 * Detection form, kept free of the `g` flag so `.test()` is stateless —
 * a shared global regex would carry `lastIndex` between calls and start
 * answering `false` for addresses it had already seen.
 */
export const EMAIL_ADDRESS_PATTERN = new RegExp(EMAIL_ADDRESS_SOURCE);

/** Replacement form. Same source, so it can never diverge from the detector. */
const EMAIL_ADDRESS_PATTERN_GLOBAL = new RegExp(EMAIL_ADDRESS_SOURCE, "g");

/**
 * Replaces every address in `text` with the sentinel, leaving the rest of the
 * string untouched. Idempotent: the sentinel contains no `@`, so re-running
 * the scrubber over its own output is a no-op.
 */
export function redactEmailAddresses(text: string): string {
  return text.replace(EMAIL_ADDRESS_PATTERN_GLOBAL, EMAIL_REDACTION_SENTINEL);
}

/**
 * Fixture-guard half of the email rule: walks a parsed frame and throws on
 * the first string — value OR key — that still carries an address.
 *
 * Object KEYS are checked even though `scrubValue` only rewrites values. A
 * capture keyed by address (`{ seats: { "a@b.com": ... } }`) cannot be fixed
 * by a blind rewrite without silently collapsing two keys into one, so the
 * gate fails closed and a human decides what to do. That has not happened
 * yet; if it ever does, the failure names the parent path.
 *
 * The message never repeats the address it matched. Guard failures land in CI
 * logs, and reprinting the PII there would republish exactly what this gate
 * exists to withhold — the path is enough to find it locally.
 */
export function assertNoResidualEmails(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (EMAIL_ADDRESS_PATTERN.test(value)) {
      throw new Error(
        `unredacted email address at ${path} (value withheld: it is the PII this guard exists to keep out of the repository)`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoResidualEmails(item, `${path}[${index}]`),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (EMAIL_ADDRESS_PATTERN.test(key)) {
        // The parent path, not `${path}.${key}` — the key IS the address.
        throw new Error(
          `unredacted email address in key at ${path.length > 0 ? path : "<root>"} (value withheld: it is the PII this guard exists to keep out of the repository)`,
        );
      }
      const childPath = path.length > 0 ? `${path}.${key}` : key;
      assertNoResidualEmails(child, childPath);
    }
  }
  // null / number / boolean: cannot carry an address.
}

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
