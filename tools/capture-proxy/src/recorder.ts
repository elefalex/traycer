import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type RecordedFrame = {
  readonly ts: number;
  readonly connId: string;
  readonly leg: "rpc" | "stream";
  readonly direction: "c2h" | "h2c";
  readonly kind: string;
  readonly method: string | null;
  readonly schemaVersion: { readonly major: number; readonly minor: number } | null;
  readonly payload: unknown;
};

export class Recorder {
  private stream: WriteStream | null = null;

  constructor(private readonly filePath: string) {}

  async append(frame: RecordedFrame): Promise<void> {
    if (this.stream === null) {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.stream = createWriteStream(this.filePath, { flags: "a" });
    }
    const line = `${JSON.stringify(frame)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.stream?.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    const stream = this.stream;
    if (stream === null) return;
    this.stream = null;
    await new Promise<void>((resolve) => stream.end(resolve));
  }
}
