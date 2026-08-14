import { describe, expect, it } from "vitest";
import { scrubFrame, scrubRecording } from "../scrub";
import type { RecordedFrame } from "../recorder";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const base: RecordedFrame = {
  ts: 1,
  connId: "c1",
  leg: "rpc",
  direction: "c2h",
  kind: "open",
  method: null,
  schemaVersion: null,
  payload: {},
};

describe("scrubFrame", () => {
  it("redacts token fields and home paths", () => {
    const frame: RecordedFrame = {
      ...base,
      payload: {
        kind: "open",
        token: "secret-jwt-value",
        manifest: { cwd: "/Users/alex/code/app" },
      },
    };
    const scrubbed = scrubFrame(frame, "/Users/alex");
    const payload = scrubbed.payload as {
      token: string;
      manifest: { cwd: string };
    };
    expect(payload.token).toBe("<redacted-token>");
    expect(payload.manifest.cwd).toBe("<home>/code/app");
  });

  it("does not mutate the input frame", () => {
    const frame: RecordedFrame = { ...base, payload: { token: "x" } };
    scrubFrame(frame, "/Users/alex");
    expect((frame.payload as { token: string }).token).toBe("x");
  });

  it("redacts tokens nested deep inside arrays and objects", () => {
    const frame: RecordedFrame = {
      ...base,
      payload: {
        frames: [
          {
            open: {
              token: "deep-secret",
              data: { nested: { token: "another-secret" } },
            },
          },
        ],
      },
    };
    const scrubbed = scrubFrame(frame, "/Users/alex");
    const payload = scrubbed.payload as Record<string, unknown>;
    const frames = payload.frames as Array<Record<string, unknown>>;
    const firstFrame = frames[0] as Record<string, unknown>;
    const open = firstFrame.open as Record<string, unknown>;
    const nested = open.data as Record<string, Record<string, unknown>>;
    expect(open.token).toBe("<redacted-token>");
    expect(nested.nested.token).toBe("<redacted-token>");
  });

  it("matches token key case-insensitively", () => {
    const frame1: RecordedFrame = {
      ...base,
      payload: { Token: "secret1" },
    };
    const frame2: RecordedFrame = {
      ...base,
      payload: { TOKEN: "secret2" },
    };
    const frame3: RecordedFrame = {
      ...base,
      payload: { token: "secret3" },
    };
    const scrubbed1 = scrubFrame(frame1, "/Users/alex");
    const scrubbed2 = scrubFrame(frame2, "/Users/alex");
    const scrubbed3 = scrubFrame(frame3, "/Users/alex");
    expect((scrubbed1.payload as Record<string, unknown>).Token).toBe(
      "<redacted-token>"
    );
    expect((scrubbed2.payload as Record<string, unknown>).TOKEN).toBe(
      "<redacted-token>"
    );
    expect((scrubbed3.payload as Record<string, unknown>).token).toBe(
      "<redacted-token>"
    );
  });

  it("replaces home path in nested strings and array elements", () => {
    const frame: RecordedFrame = {
      ...base,
      payload: {
        paths: ["/Users/alex/project/src", "/Users/alex/data.json"],
        config: {
          root: "/Users/alex/project",
          exclude: ["/Users/alex/.cache"],
        },
      },
    };
    const scrubbed = scrubFrame(frame, "/Users/alex");
    const payload = scrubbed.payload as Record<string, unknown>;
    const paths = payload.paths as string[];
    const config = payload.config as Record<string, unknown>;
    const exclude = config.exclude as string[];
    expect(paths[0]).toBe("<home>/project/src");
    expect(paths[1]).toBe("<home>/data.json");
    expect(config.root).toBe("<home>/project");
    expect(exclude[0]).toBe("<home>/.cache");
  });

  it("leaves non-string values structurally intact", () => {
    const frame: RecordedFrame = {
      ...base,
      payload: {
        count: 42,
        enabled: true,
        disabled: false,
        empty: null,
        items: [1, 2, 3],
        nested: {
          value: 123,
          flag: false,
          nothing: null,
          array: [true, false, 0],
        },
      },
    };
    const scrubbed = scrubFrame(frame, "/Users/alex");
    const payload = scrubbed.payload as Record<string, unknown>;
    expect(payload.count).toBe(42);
    expect(payload.enabled).toBe(true);
    expect(payload.disabled).toBe(false);
    expect(payload.empty).toBe(null);
    expect(payload.items).toEqual([1, 2, 3]);
    const nested = payload.nested as Record<string, unknown>;
    expect(nested.value).toBe(123);
    expect(nested.flag).toBe(false);
    expect(nested.nothing).toBe(null);
    expect(nested.array).toEqual([true, false, 0]);
  });

  it("scrubRecording round-trip preserves frame count and redacts secrets", async () => {
    const inPath = join(tmpdir(), `scrub-input-${Date.now()}.jsonl`);
    const outPath = join(tmpdir(), `scrub-output-${Date.now()}.jsonl`);

    const frame1: RecordedFrame = {
      ts: 1,
      connId: "c1",
      leg: "rpc",
      direction: "c2h",
      kind: "open",
      method: null,
      schemaVersion: null,
      payload: {
        kind: "open",
        token: "secret-token-123",
        home: "/Users/alex/project",
      },
    };

    const frame2: RecordedFrame = {
      ts: 2,
      connId: "c1",
      leg: "rpc",
      direction: "h2c",
      kind: "response",
      method: "ping",
      schemaVersion: null,
      payload: {
        cwd: "/Users/alex/work/src",
        items: [
          { token: "nested-secret", path: "/Users/alex/data" },
        ],
      },
    };

    await writeFile(
      inPath,
      `${JSON.stringify(frame1)}\n${JSON.stringify(frame2)}\n`,
      "utf8"
    );

    const result = await scrubRecording({
      inPath,
      outPath,
      homeDir: "/Users/alex",
    });

    expect(result.count).toBe(2);

    const outContent = await readFile(outPath, "utf8");
    const outLines = outContent
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(outLines).toHaveLength(2);

    const scrubbed1 = JSON.parse(outLines[0]) as RecordedFrame;
    const scrubbed2 = JSON.parse(outLines[1]) as RecordedFrame;

    const payload1 = scrubbed1.payload as Record<string, unknown>;
    expect(payload1.token).toBe("<redacted-token>");
    expect(payload1.home).toBe("<home>/project");

    const payload2 = scrubbed2.payload as Record<string, unknown>;
    expect(payload2.cwd).toBe("<home>/work/src");
    const items = payload2.items as Array<Record<string, unknown>>;
    expect(items[0].token).toBe("<redacted-token>");
    expect(items[0].path).toBe("<home>/data");
  });
});
