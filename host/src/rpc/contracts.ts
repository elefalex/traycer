import type {
  AnyRpcContract,
  SchemaVersion,
  VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host";

/**
 * `hostRpcRegistry`'s exported type parameterizes
 * `ValidatedVersionedRpcRegistryMethods` over the literal method-name union
 * (`protocol/src/host/registry.ts:7450-7454`), so indexing it with a runtime
 * `string` does not type-check directly. Re-typing the reference as the
 * UNPARAMETERIZED `VersionedRpcRegistry` falls back to
 * `UncheckedVersionedRpcRegistry`'s `Record<string, ...>` index signature
 * (`versioned-rpc-types.ts:321-323`), which is exactly how
 * `compatibility-checker.ts`'s `check()`/`getMajorLine` (:42, :150-166) type
 * their own `myRegistry: VersionedRpcRegistry` parameters — same registry,
 * same widening, no cast.
 */
const registry: VersionedRpcRegistry = hostRpcRegistry;

/**
 * Looks up the contract for `method` at exactly `version` (not the closest
 * version, not the canonical one) by walking the registry nesting
 * `registry[method][major].versions[minor]` per `getMajorLine`
 * (`protocol/src/framework/compatibility-checker.ts:150-166`). Each installed
 * slot carries a `contract` with `requestSchema`/`responseSchema`
 * (`versioned-rpc-types.ts:69-77`).
 *
 * Returns `null` for an unregistered method, an unregistered major line, or a
 * minor not installed on that line — three distinct "not found" reasons that
 * a caller validating a domain handler's response does not need to
 * distinguish.
 */
export function contractFor(
  method: string,
  version: SchemaVersion,
): AnyRpcContract | null {
  if (!Object.prototype.hasOwnProperty.call(registry, method)) return null;
  const methodRegistry = registry[method];
  if (!Object.prototype.hasOwnProperty.call(methodRegistry, version.major)) {
    return null;
  }
  const majorLine = methodRegistry[version.major];
  if (
    !Object.prototype.hasOwnProperty.call(majorLine.versions, version.minor)
  ) {
    return null;
  }
  return majorLine.versions[version.minor].contract;
}
