/// <reference lib="esnext.disposable" preserve="true" />
import type { ProgramAttachment } from "@sweatpants/durable-execution";

export type AttachmentMetadata = Omit<ProgramAttachment, "handle">;
export type ExecutorResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: { code: string; message: string };
    };

/** JSON wire envelopes avoid recursive Cloudflare RPC mapped types leaking into app code. */
export interface ToolExecutorRpc {
  attach(request: string): Promise<string>;
  step(attachmentId: string, command: string): Promise<string>;
  shutdown(attachmentId: string, reason: string): Promise<string>;
  [Symbol.dispose](): void | Promise<void>;
}

export interface ToolExecutorEntrypoint {
  createExecutor(): Promise<ToolExecutorRpc>;
}
