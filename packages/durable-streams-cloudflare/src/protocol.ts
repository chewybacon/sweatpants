import type { SessionEntry } from "@sweatpants/durable-streams";
export type Reply<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
export interface Fence {
  ownerId: string;
  activationEpoch: number;
}
export interface BufferState {
  lsn: number;
  complete: boolean;
  error: { name: string; message: string } | null;
}
/** Only serializable values cross the placement boundary. */
export interface ResponseStreamRpc {
  waitForChange(readerId: string, after: number): Promise<Reply<void>>;
  cancelWait(readerId: string): Promise<Reply<void>>;
  createBuffer(): Promise<Reply<void>>;
  bufferState(): Promise<Reply<BufferState | null>>;
  removeBuffer(): Promise<Reply<void>>;
  claim(fence: Fence): Promise<Reply<void>>;
  append(fence: Fence, tokens: string[]): Promise<Reply<number>>;
  closeBuffer(fence: Fence, error: BufferState["error"]): Promise<Reply<void>>;
  read(after: number, limit: number | null): Promise<Reply<{ tokens: string[]; lsn: number }>>;
  latest(): Promise<Reply<{ token: string | null; lsn: number }>>;
  getEntry(): Promise<Reply<SessionEntry | null>>;
  setEntry(entry: SessionEntry): Promise<Reply<void>>;
  removeEntry(): Promise<Reply<void>>;
  updateRefCount(delta: number): Promise<Reply<number>>;
}
export interface ResponseStreamNamespace {
  getByName(name: string): ResponseStreamRpc;
}
