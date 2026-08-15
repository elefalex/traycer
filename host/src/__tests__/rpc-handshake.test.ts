import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHostManifest, handleOpenFrame } from "../handshake/rpc-handshake";

const FIXTURE = join(
  __dirname,
  "..",
  "..",
  "..",
  "tools",
  "capture-proxy",
  "fixtures",
  "boot.scrubbed.jsonl",
);

type Recorded = {
  readonly leg: string;
  readonly kind: string;
  readonly payload: unknown;
};

async function recordedFrames(kind: string): Promise<unknown[]> {
  const text = await readFile(FIXTURE, "utf8");
  const out: unknown[] = [];
  for (const line of text.trim().split("\n")) {
    const frame = JSON.parse(line) as Recorded;
    if (frame.leg === "rpc" && frame.kind === kind) out.push(frame.payload);
  }
  return out;
}

describe("rpc handshake", () => {
  it("advertises exactly the 113-method floor as required", () => {
    const { manifest } = buildHostManifest();
    expect(Object.keys(manifest)).toHaveLength(113);
  });

  it("advertises no optional methods in this milestone", () => {
    expect(Object.keys(buildHostManifest().optionalManifest)).toEqual([]);
  });

  it("accepts every real recorded client open frame", async () => {
    const opens = await recordedFrames("open");
    expect(opens.length).toBeGreaterThan(0);
    for (const open of opens) {
      expect(handleOpenFrame(open).kind).toBe("openAck");
    }
  });

  it("advertises the same required method NAMES the real host did", async () => {
    const [recordedAck] = (await recordedFrames("openAck")) as [
      { readonly manifest: Record<string, unknown> },
    ];
    const ours = Object.keys(buildHostManifest().manifest).sort();
    expect(ours).toEqual(Object.keys(recordedAck.manifest).sort());
  });

  it("rejects a client that is missing a floor method", () => {
    const { manifest } = buildHostManifest();
    const truncated = { ...manifest };
    delete truncated["host.status"];
    const outcome = handleOpenFrame({
      kind: "open",
      token: "ignored",
      manifest: truncated,
      optionalManifest: {},
    });
    expect(outcome.kind).toBe("fatalError");
    if (outcome.kind !== "fatalError") throw new Error("unreachable");
    expect(outcome.frame.details.code).toBe("INCOMPATIBLE");
  });

  it("never echoes the bearer token into a rejected open's response frame", () => {
    const { manifest } = buildHostManifest();
    const truncated = { ...manifest };
    delete truncated["host.status"];
    const secretToken = "live-cloud-credential-do-not-leak-9f3a7c";
    const outcome = handleOpenFrame({
      kind: "open",
      token: secretToken,
      manifest: truncated,
      optionalManifest: {},
    });
    expect(outcome.kind).toBe("fatalError");
    expect(JSON.stringify(outcome)).not.toContain(secretToken);
  });

  it("rejects a structurally invalid open frame", () => {
    expect(handleOpenFrame({ kind: "open" }).kind).toBe("fatalError");
  });

  it("shapes a structurally invalid open frame's details as PROTOCOL_ERROR", () => {
    const outcome = handleOpenFrame({ kind: "open" });
    expect(outcome.kind).toBe("fatalError");
    if (outcome.kind !== "fatalError") throw new Error("unreachable");
    expect(outcome.frame.details.code).toBe("PROTOCOL_ERROR");
    expect(typeof outcome.frame.details.reason).toBe("string");
    expect(outcome.frame.details.reason.length).toBeGreaterThan(0);
    expect(outcome.frame.details.incompatibleMethods).toBeNull();
    expect(outcome.frame.details.upgradeGuidance).toBeNull();
  });
});
