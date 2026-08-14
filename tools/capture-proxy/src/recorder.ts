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
  private initPromise: Promise<WriteStream> | null = null;
  private streamError: Error | null = null;

  constructor(private readonly filePath: string) {}

  private async init(): Promise<WriteStream> {
    if (this.initPromise === null) {
      this.initPromise = this.createStream();
    }
    return this.initPromise;
  }

  private async createStream(): Promise<WriteStream> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const stream = createWriteStream(this.filePath, { flags: "a" });
    stream.on("error", (err) => {
      this.streamError = err;
    });
    this.stream = stream;
    return stream;
  }

  async append(frame: RecordedFrame): Promise<void> {
    if (this.streamError !== null) {
      throw this.streamError;
    }
    const stream = await this.init();
    if (this.streamError !== null) {
      throw this.streamError;
    }
    const line = `${JSON.stringify(frame)}\n`;
    await new Promise<void>((resolve, reject) => {
      stream.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    const stream = this.stream;
    if (stream === null) return;
    this.stream = null;
    this.initPromise = null;
    await new Promise<void>((resolve) => stream.end(resolve));
  }
}
