// Wiring test for the open host's dependency on `@traycer/protocol`.
//
// This is the first line of defense against designing the host against an
// imagined wire shape: it imports the *real* registries from TypeScript
// source (no build step) and pins the two facts every later task in this
// plan depends on. If either count assertion below fails, the protocol
// changed under this plan — do not edit the numbers to match; treat it as a
// signal to stop and re-derive the manifest.
//
// - `hostRpcRegistry` / `hostStreamRpcRegistry`: protocol/src/host/index.ts
//   (re-exported from protocol/src/host/registry.ts).
// - `RELEASED_FLOOR_METHOD_NAMES`: protocol/src/host/released-floor.ts.
import { hostRpcRegistry, hostStreamRpcRegistry } from "@traycer/protocol/host";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { describe, expect, it } from "vitest";

describe("protocol wiring", () => {
  it("imports the host registries from TypeScript source", () => {
    expect(Object.keys(hostRpcRegistry).length).toBeGreaterThan(0);
    expect(Object.keys(hostStreamRpcRegistry)).toHaveLength(25);
  });

  it("pins the released floor at the size the capture measured", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).toHaveLength(113);
  });

  it("has a floor that is a subset of the registry", () => {
    const registered = new Set(Object.keys(hostRpcRegistry));
    const missing = RELEASED_FLOOR_METHOD_NAMES.filter(
      (name) => !registered.has(name),
    );
    expect(missing).toEqual([]);
  });
});
