import { describe, expect, it } from "vitest";
import { scrubFrame, scrubRecording } from "../scrub";
import { createWorkspaceAliases } from "../secret-rule";
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
    const scrubbed = scrubFrame(frame, "/Users/alex", createWorkspaceAliases());
    const payload = scrubbed.payload as {
      token: string;
      manifest: { cwd: string };
    };
    expect(payload.token).toBe("<redacted-token>");
    // The home prefix goes first, then the workspace rule takes the segments
    // it left behind (`code/app` names the operator's project).
    expect(payload.manifest.cwd).toBe("<home>/<workspace-1>");
  });

  it("does not mutate the input frame", () => {
    const frame: RecordedFrame = { ...base, payload: { token: "x" } };
    scrubFrame(frame, "/Users/alex", createWorkspaceAliases());
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
    const scrubbed = scrubFrame(frame, "/Users/alex", createWorkspaceAliases());
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
    const scrubbed1 = scrubFrame(
      frame1,
      "/Users/alex",
      createWorkspaceAliases(),
    );
    const scrubbed2 = scrubFrame(
      frame2,
      "/Users/alex",
      createWorkspaceAliases(),
    );
    const scrubbed3 = scrubFrame(
      frame3,
      "/Users/alex",
      createWorkspaceAliases(),
    );
    expect((scrubbed1.payload as Record<string, unknown>).Token).toBe(
      "<redacted-token>",
    );
    expect((scrubbed2.payload as Record<string, unknown>).TOKEN).toBe(
      "<redacted-token>",
    );
    expect((scrubbed3.payload as Record<string, unknown>).token).toBe(
      "<redacted-token>",
    );
  });

  it("replaces home path in nested strings and array elements, one placeholder per distinct path", () => {
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
    const scrubbed = scrubFrame(frame, "/Users/alex", createWorkspaceAliases());
    const payload = scrubbed.payload as Record<string, unknown>;
    const paths = payload.paths as string[];
    const config = payload.config as Record<string, unknown>;
    const exclude = config.exclude as string[];
    // Traversal order is what fixes the numbering: `paths` first, then
    // `config`. Each distinct path gets its own placeholder.
    expect(paths[0]).toBe("<home>/<workspace-1>");
    expect(paths[1]).toBe("<home>/<workspace-2>");
    expect(config.root).toBe("<home>/<workspace-3>");
    expect(exclude[0]).toBe("<home>/<workspace-4>");
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
    const scrubbed = scrubFrame(frame, "/Users/alex", createWorkspaceAliases());
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
        items: [{ token: "nested-secret", path: "/Users/alex/data" }],
      },
    };

    await writeFile(
      inPath,
      `${JSON.stringify(frame1)}\n${JSON.stringify(frame2)}\n`,
      "utf8",
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
    expect(payload1.home).toBe("<home>/<workspace-1>");

    // Numbering continues across frames of the same recording: one table for
    // the whole file, so frame 2's paths follow frame 1's.
    const payload2 = scrubbed2.payload as Record<string, unknown>;
    expect(payload2.cwd).toBe("<home>/<workspace-2>");
    const items = payload2.items as Array<Record<string, unknown>>;
    expect(items[0].token).toBe("<redacted-token>");
    expect(items[0].path).toBe("<home>/<workspace-3>");

    // Blanket assertion: no raw secret strings should survive
    expect(outContent).not.toContain("secret-token-123");
    expect(outContent).not.toContain("nested-secret");
  });

  it("redacts tokens that are array values under a token key", () => {
    const frame: RecordedFrame = {
      ...base,
      payload: {
        token: ["secret-jwt-1", "secret-jwt-2"],
      },
    };
    const scrubbed = scrubFrame(frame, "/Users/alex", createWorkspaceAliases());
    const payload = scrubbed.payload as Record<string, unknown>;
    const tokens = payload.token as string[];
    expect(tokens[0]).toBe("<redacted-token>");
    expect(tokens[1]).toBe("<redacted-token>");
    // Blanket check: raw secrets must not appear in stringified output
    const stringified = JSON.stringify(scrubbed.payload);
    expect(stringified).not.toContain("secret-jwt-1");
    expect(stringified).not.toContain("secret-jwt-2");
  });

  it("redacts tokens in nested arrays with mixed types", () => {
    const frame: RecordedFrame = {
      ...base,
      payload: {
        auth: {
          token: ["a-secret", { inner: "not-a-token" }],
        },
      },
    };
    const scrubbed = scrubFrame(frame, "/Users/alex", createWorkspaceAliases());
    const payload = scrubbed.payload as Record<string, unknown>;
    const auth = payload.auth as Record<string, unknown>;
    const tokens = auth.token as Array<string | Record<string, unknown>>;
    expect(tokens[0]).toBe("<redacted-token>");
    const objElement = tokens[1] as Record<string, unknown>;
    expect(objElement.inner).toBe("not-a-token");
    // Blanket check: raw secret must not appear
    const stringified = JSON.stringify(scrubbed.payload);
    expect(stringified).not.toContain("a-secret");
  });

  it("scrubRecording redacts tokens in array values", async () => {
    const inPath = join(tmpdir(), `scrub-array-input-${Date.now()}.jsonl`);
    const outPath = join(tmpdir(), `scrub-array-output-${Date.now()}.jsonl`);

    const frameWithTokenArray: RecordedFrame = {
      ts: 1,
      connId: "c1",
      leg: "rpc",
      direction: "c2h",
      kind: "open",
      method: null,
      schemaVersion: null,
      payload: {
        kind: "open",
        token: ["jwt-secret-1", "jwt-secret-2"],
      },
    };

    await writeFile(inPath, `${JSON.stringify(frameWithTokenArray)}\n`, "utf8");

    await scrubRecording({
      inPath,
      outPath,
      homeDir: "/Users/alex",
    });

    const outContent = await readFile(outPath, "utf8");
    // Blanket assertion: no raw token values should survive in output
    expect(outContent).not.toContain("jwt-secret-1");
    expect(outContent).not.toContain("jwt-secret-2");
    // Verify the tokens were redacted
    const outLines = outContent
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const scrubbedFrame = JSON.parse(outLines[0]) as RecordedFrame;
    const payload = scrubbedFrame.payload as Record<string, unknown>;
    const tokens = payload.token as string[];
    expect(tokens[0]).toBe("<redacted-token>");
    expect(tokens[1]).toBe("<redacted-token>");
  });
});

// Email redaction is VALUE-based: it fires on the shape of the string, not on
// the key it sits under. A live capture put the operator's address under
// `email`, under `createdBy`, and deeper still inside free text — a key-name
// list would have missed whichever fields it failed to enumerate.
describe("scrubFrame email redaction", () => {
  function payloadOf(
    payload: unknown,
    homeDir: string,
  ): Record<string, unknown> {
    return scrubFrame({ ...base, payload }, homeDir, createWorkspaceAliases())
      .payload as Record<string, unknown>;
  }

  it("redacts a value under an email key", () => {
    const scrubbed = payloadOf({ email: "someone@example.com" }, "/Users/alex");
    expect(scrubbed.email).toBe("<redacted-email>");
    expect(JSON.stringify(scrubbed)).not.toContain("someone@example.com");
  });

  it("redacts under any key name, not a list of known ones", () => {
    const scrubbed = payloadOf(
      { createdBy: "someone@example.com", owner: "someone@example.com" },
      "/Users/alex",
    );
    expect(scrubbed.createdBy).toBe("<redacted-email>");
    expect(scrubbed.owner).toBe("<redacted-email>");
  });

  it("replaces only the address inside a longer string", () => {
    const scrubbed = payloadOf(
      { note: "task created by someone@example.com on Tuesday" },
      "/Users/alex",
    );
    expect(scrubbed.note).toBe("task created by <redacted-email> on Tuesday");
  });

  it("redacts every address in a string carrying more than one", () => {
    const scrubbed = payloadOf(
      { note: "from a@x.com to b@y.org" },
      "/Users/alex",
    );
    expect(scrubbed.note).toBe("from <redacted-email> to <redacted-email>");
  });

  it("redacts addresses inside arrays", () => {
    const scrubbed = payloadOf(
      { members: ["someone@example.com", "other@example.org", "plain"] },
      "/Users/alex",
    );
    expect(scrubbed.members).toEqual([
      "<redacted-email>",
      "<redacted-email>",
      "plain",
    ]);
  });

  it("redacts an address nested several levels under non-secret keys", () => {
    const scrubbed = payloadOf(
      {
        result: {
          tasks: [{ meta: { author: { contact: "someone@example.com" } } }],
        },
      },
      "/Users/alex",
    );
    expect(JSON.stringify(scrubbed)).not.toContain("someone@example.com");
    expect(JSON.stringify(scrubbed)).toContain("<redacted-email>");
  });

  it("emits only the token sentinel for a secret-key string containing an address", () => {
    // Credential redaction wins outright: a half-redacted token
    // (`"<redacted-email>.<signature>"`) would leak the parts either rule
    // failed to cover.
    const scrubbed = payloadOf(
      { token: "jwt-for-someone@example.com-issued" },
      "/Users/alex",
    );
    expect(scrubbed.token).toBe("<redacted-token>");
    expect(scrubbed.token).not.toContain("<redacted-email>");
    expect(JSON.stringify(scrubbed)).not.toContain("someone@example.com");
  });

  it("emits only the token sentinel for array elements under a secret key", () => {
    const scrubbed = payloadOf(
      { apiKey: ["sk-someone@example.com", "sk-plain"] },
      "/Users/alex",
    );
    expect(scrubbed.apiKey).toEqual(["<redacted-token>", "<redacted-token>"]);
    expect(JSON.stringify(scrubbed)).not.toContain("someone@example.com");
  });

  it("leaves non-address `@` strings untouched", () => {
    const payload = {
      cmd: "npm i @scope/pkg",
      host: "user@host",
      pkg: "@traycer/protocol",
      when: "build @ 2026-08-14",
    };
    expect(payloadOf(payload, "/Users/alex")).toEqual(payload);
  });

  it("applies home-dir substitution and email redaction to the same string", () => {
    const scrubbed = payloadOf(
      { log: "/Users/alex/inbox owned by someone@example.com" },
      "/Users/alex",
    );
    expect(scrubbed.log).toBe("<home>/<workspace-1> owned by <redacted-email>");
  });

  it("redacts addresses when no home dir is configured", () => {
    const scrubbed = payloadOf({ email: "someone@example.com" }, "");
    expect(scrubbed.email).toBe("<redacted-email>");
  });

  it("scrubRecording strips addresses end to end", async () => {
    const inPath = join(tmpdir(), `scrub-email-input-${Date.now()}.jsonl`);
    const outPath = join(tmpdir(), `scrub-email-output-${Date.now()}.jsonl`);
    const frame: RecordedFrame = {
      ...base,
      payload: {
        email: "someone@example.com",
        createdBy: "someone@example.com",
        nested: { note: "ping someone@example.com", list: ["a@b.io"] },
      },
    };

    await writeFile(inPath, `${JSON.stringify(frame)}\n`, "utf8");
    await scrubRecording({ inPath, outPath, homeDir: "/Users/alex" });

    const outContent = await readFile(outPath, "utf8");
    expect(outContent).not.toContain("someone@example.com");
    expect(outContent).not.toContain("a@b.io");
    expect(outContent).toContain("<redacted-email>");
  });
});

// Workspace redaction is the third rule, and the only stateful one: the same
// path must come out as the same placeholder everywhere in a recording, or two
// frames that named one directory stop matching each other on replay. The
// paths below are the shapes a live capture actually carried
// (`<home>/Projects/personal/rental-platform`), with the private names swapped
// for neutral stand-ins.
describe("scrubFrame workspace path redaction", () => {
  function payloadOf(payload: unknown): Record<string, unknown> {
    return scrubFrame(
      { ...base, payload },
      "/Users/alex",
      createWorkspaceAliases(),
    ).payload as Record<string, unknown>;
  }

  it("replaces the segments left under <home> with a placeholder", () => {
    const scrubbed = payloadOf({
      workspacePath: "/Users/alex/Projects/personal/rental-platform",
    });
    expect(scrubbed.workspacePath).toBe("<home>/<workspace-1>");
    expect(JSON.stringify(scrubbed)).not.toContain("rental-platform");
  });

  it("gives two different paths two different placeholders", () => {
    const scrubbed = payloadOf({
      a: "/Users/alex/Projects/personal/rental-platform",
      b: "/Users/alex/Projects/skytrack/backendcarbnb",
    });
    expect(scrubbed.a).toBe("<home>/<workspace-1>");
    expect(scrubbed.b).toBe("<home>/<workspace-2>");
    const stringified = JSON.stringify(scrubbed);
    expect(stringified).not.toContain("skytrack");
    expect(stringified).not.toContain("carbnb");
  });

  it("gives one path the same placeholder every time it appears", () => {
    const scrubbed = payloadOf({
      first: "/Users/alex/Projects/skytrack/backendcarbnb",
      other: "/Users/alex/Projects/personal/rental-platform",
      second: "/Users/alex/Projects/skytrack/backendcarbnb",
    });
    expect(scrubbed.first).toBe("<home>/<workspace-1>");
    expect(scrubbed.other).toBe("<home>/<workspace-2>");
    expect(scrubbed.second).toBe("<home>/<workspace-1>");
  });

  it("treats a path and a deeper path under it as different paths", () => {
    // Reconstructing which prefix is "the workspace root" would be guesswork
    // over a tree this tool never sees, so each distinct string is its own
    // path. Both are redacted; only the numbering differs.
    const scrubbed = payloadOf({
      root: "/Users/alex/Projects/personal/rental-platform",
      file: "/Users/alex/Projects/personal/rental-platform/src/index.ts",
    });
    expect(scrubbed.root).toBe("<home>/<workspace-1>");
    expect(scrubbed.file).toBe("<home>/<workspace-2>");
  });

  it("replaces only the path portion of a longer string", () => {
    const scrubbed = payloadOf({
      note: "opened /Users/alex/Projects/personal/rental-platform in the editor",
    });
    expect(scrubbed.note).toBe("opened <home>/<workspace-1> in the editor");
  });

  it("replaces every path in a string carrying more than one", () => {
    const scrubbed = payloadOf({
      note: "moved /Users/alex/Projects/a to /Users/alex/Projects/b",
    });
    expect(scrubbed.note).toBe(
      "moved <home>/<workspace-1> to <home>/<workspace-2>",
    );
  });

  it("leaves a bare home path with no trailing segment alone", () => {
    const scrubbed = payloadOf({ home: "/Users/alex", cwd: "/Users/alex/" });
    expect(scrubbed.home).toBe("<home>");
    expect(scrubbed.cwd).toBe("<home>/");
  });

  it("leaves paths outside the home directory alone", () => {
    // They carry no private name, and dropping them would cost the recording
    // its replay value.
    const payload = { bin: "/usr/local/bin/node", tmp: "/tmp/run-1/socket" };
    expect(payloadOf(payload)).toEqual(payload);
  });

  it("emits only the token sentinel for a secret-key string containing a path", () => {
    const scrubbed = payloadOf({
      token: "jwt-issued-for-/Users/alex/Projects/personal/rental-platform",
    });
    expect(scrubbed.token).toBe("<redacted-token>");
    expect(scrubbed.token).not.toContain("<workspace-");
    expect(JSON.stringify(scrubbed)).not.toContain("rental-platform");
  });

  it("redacts paths inside arrays", () => {
    const scrubbed = payloadOf({
      workspaces: [
        "/Users/alex/Projects/personal/rental-platform",
        "/Users/alex/Projects/skytrack/backendcarbnb",
        "/Users/alex/Projects/personal/rental-platform",
        "not-a-path",
      ],
    });
    expect(scrubbed.workspaces).toEqual([
      "<home>/<workspace-1>",
      "<home>/<workspace-2>",
      "<home>/<workspace-1>",
      "not-a-path",
    ]);
  });

  it("redacts a path nested several levels under non-secret keys", () => {
    const scrubbed = payloadOf({
      result: {
        tasks: [
          {
            meta: { workspace: { path: "/Users/alex/Projects/skytrack/api" } },
          },
        ],
      },
    });
    const stringified = JSON.stringify(scrubbed);
    expect(stringified).not.toContain("skytrack");
    expect(stringified).toContain("<home>/<workspace-1>");
  });

  it("swallows an address-shaped path segment rather than half-redacting it", () => {
    // Workspace runs before email so the path is judged as one path; the
    // alternative leaves `<home>/Projects/` plus a surviving tail.
    const scrubbed = payloadOf({
      path: "/Users/alex/Projects/someone@example.com/app",
    });
    expect(scrubbed.path).toBe("<home>/<workspace-1>");
    expect(JSON.stringify(scrubbed)).not.toContain("someone@example.com");
  });

  it("still redacts an address next to a path in the same string", () => {
    const scrubbed = payloadOf({
      note: "/Users/alex/Projects/app owned by someone@example.com",
    });
    expect(scrubbed.note).toBe(
      "<home>/<workspace-1> owned by <redacted-email>",
    );
  });

  it("keeps numbering stable across the frames of one recording", async () => {
    const inPath = join(tmpdir(), `scrub-ws-input-${Date.now()}.jsonl`);
    const outPath = join(tmpdir(), `scrub-ws-output-${Date.now()}.jsonl`);

    const frame1: RecordedFrame = {
      ...base,
      payload: { cwd: "/Users/alex/Projects/skytrack/backendcarbnb" },
    };
    const frame2: RecordedFrame = {
      ...base,
      ts: 2,
      payload: {
        cwd: "/Users/alex/Projects/skytrack/backendcarbnb",
        other: "/Users/alex/Projects/personal/rental-platform",
      },
    };

    await writeFile(
      inPath,
      `${JSON.stringify(frame1)}\n${JSON.stringify(frame2)}\n`,
      "utf8",
    );
    await scrubRecording({ inPath, outPath, homeDir: "/Users/alex" });

    const outContent = await readFile(outPath, "utf8");
    expect(outContent).not.toContain("skytrack");
    expect(outContent).not.toContain("carbnb");
    expect(outContent).not.toContain("rental-platform");

    const outLines = outContent
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const payload1 = (JSON.parse(outLines[0]) as RecordedFrame)
      .payload as Record<string, unknown>;
    const payload2 = (JSON.parse(outLines[1]) as RecordedFrame)
      .payload as Record<string, unknown>;
    // Replay integrity: the two frames still name the same workspace.
    expect(payload1.cwd).toBe("<home>/<workspace-1>");
    expect(payload2.cwd).toBe("<home>/<workspace-1>");
    expect(payload2.other).toBe("<home>/<workspace-2>");
  });

  it("starts numbering from 1 again for the next recording", async () => {
    // Numbering is per-recording: a table shared between runs would make
    // `<workspace-1>` in one file mean whatever the previous file saw first.
    const stamp = Date.now();
    const inPath = join(tmpdir(), `scrub-ws-a-in-${stamp}.jsonl`);
    const outPathA = join(tmpdir(), `scrub-ws-a-out-${stamp}.jsonl`);
    const outPathB = join(tmpdir(), `scrub-ws-b-out-${stamp}.jsonl`);
    const frame: RecordedFrame = {
      ...base,
      payload: { cwd: "/Users/alex/Projects/personal/rental-platform" },
    };

    await writeFile(inPath, `${JSON.stringify(frame)}\n`, "utf8");
    await scrubRecording({ inPath, outPath: outPathA, homeDir: "/Users/alex" });
    await scrubRecording({ inPath, outPath: outPathB, homeDir: "/Users/alex" });

    expect(await readFile(outPathA, "utf8")).toBe(
      await readFile(outPathB, "utf8"),
    );
    expect(await readFile(outPathB, "utf8")).toContain("<home>/<workspace-1>");
  });
});
