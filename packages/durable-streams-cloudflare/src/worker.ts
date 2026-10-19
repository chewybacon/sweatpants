/// <reference types="@cloudflare/workers-types" preserve="true" />
import { DurableObject } from "cloudflare:workers";
import { StaleTokenWriterError, type SessionEntry } from "@sweatpants/durable-streams";
import type { BufferState, Fence, Reply, ResponseStreamRpc } from "./protocol.ts";

type StateRow = {
  tail: number;
  completed: number;
  error_name: string | null;
  error_message: string | null;
  owner: string | null;
  epoch: number | null;
};

/** One named DO per response stream. Its data is delivery state, never journal authority. */
export class ResponseStream extends DurableObject<unknown> implements ResponseStreamRpc {
  private readonly waiters = new Map<string, () => void>();

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS buffer (
      id INTEGER PRIMARY KEY CHECK(id=1), tail INTEGER NOT NULL, completed INTEGER NOT NULL,
      error_name TEXT, error_message TEXT, owner TEXT, epoch INTEGER);
      CREATE TABLE IF NOT EXISTS tokens (lsn INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS registry (id INTEGER PRIMARY KEY CHECK(id=1), ref_count INTEGER NOT NULL, created_at INTEGER NOT NULL);`);
  }

  // Serialize failures as data: RPC preserves the stale-writer code across isolates.
  private execute<T>(operation: () => T): Promise<Reply<T>> {
    try {
      const value = this.ctx.storage.transactionSync(operation);
      return Promise.resolve({ ok: true, value });
    } catch (error) {
      return Promise.resolve({
        ok: false,
        code: error instanceof StaleTokenWriterError ? error.code : "response_stream_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  private state(): StateRow | null {
    return (
      this.ctx.storage.sql.exec<StateRow>("SELECT * FROM buffer WHERE id=1").toArray()[0] ?? null
    );
  }
  private requireState(): StateRow {
    const state = this.state();
    if (!state) {
      throw new Error("Response buffer does not exist");
    }
    return state;
  }
  private writer(fence: Fence): StateRow {
    const state = this.requireState();
    if (state.owner !== fence.ownerId || state.epoch !== fence.activationEpoch) {
      throw new StaleTokenWriterError();
    }
    return state;
  }
  async waitForChange(readerId: string, after: number): Promise<Reply<void>> {
    const result = await this.bufferState();
    if (!result.ok) {
      return result;
    }
    if (!result.value) {
      return {
        ok: false,
        code: "response_stream_error",
        message: "Response buffer does not exist",
      };
    }
    if (result.value.lsn > after || result.value.complete) {
      return { ok: true, value: undefined };
    }
    if (this.waiters.has(readerId)) {
      return { ok: false, code: "response_stream_error", message: "Duplicate response waiter" };
    }
    return new Promise((resolve) => {
      // A dead host cannot leave an unbounded waiter. Live clients recheck the
      // persisted tail after the bounded wait, so no notification is authority.
      const timer = setTimeout(finish, 30_000);
      const waiters = this.waiters;
      function finish() {
        clearTimeout(timer);
        waiters.delete(readerId);
        resolve({ ok: true, value: undefined });
      }
      this.waiters.set(readerId, finish);
      // Register, then recheck without yielding: append between the first
      // status read and registration must not lose a wakeup.
      const state = this.state();
      if (!state || state.tail > after || state.completed) {
        finish();
      }
    });
  }
  cancelWait(readerId: string): Promise<Reply<void>> {
    this.waiters.get(readerId)?.();
    return Promise.resolve({ ok: true, value: undefined });
  }
  private notifyReaders(): void {
    for (const finish of this.waiters.values()) {
      finish();
    }
  }
  createBuffer(): Promise<Reply<void>> {
    return this.execute(() => {
      if (this.state()) {
        throw new Error("Response buffer already exists");
      }
      this.ctx.storage.sql.exec("INSERT INTO buffer(id,tail,completed) VALUES(1,0,0)");
    });
  }
  bufferState(): Promise<Reply<BufferState | null>> {
    return this.execute(() => {
      const state = this.state();
      return state
        ? {
            lsn: state.tail,
            complete: state.completed === 1,
            error:
              state.error_message === null
                ? null
                : { name: state.error_name ?? "Error", message: state.error_message },
          }
        : null;
    });
  }
  removeBuffer(): Promise<Reply<void>> {
    return this.execute(() => {
      this.ctx.storage.sql.exec("DELETE FROM tokens; DELETE FROM buffer;");
      this.notifyReaders();
    });
  }
  claim(fence: Fence): Promise<Reply<void>> {
    return this.execute(() => {
      if (
        !fence.ownerId ||
        !Number.isSafeInteger(fence.activationEpoch) ||
        fence.activationEpoch < 0
      ) {
        throw new Error("Writer owner and nonnegative activation epoch are required");
      }
      const state = this.requireState();
      if (
        state.epoch !== null &&
        (fence.activationEpoch < state.epoch ||
          (fence.activationEpoch === state.epoch && fence.ownerId !== state.owner))
      ) {
        throw new StaleTokenWriterError();
      }
      this.ctx.storage.sql.exec(
        "UPDATE buffer SET owner=?,epoch=? WHERE id=1",
        fence.ownerId,
        fence.activationEpoch,
      );
    });
  }
  append(fence: Fence, tokens: string[]): Promise<Reply<number>> {
    return this.execute(() => {
      const state = this.writer(fence);
      if (state.completed) {
        throw new Error("Buffer is closed");
      }
      const tail = state.tail + tokens.length;
      if (!Number.isSafeInteger(tail)) {
        throw new Error("Response stream offset exceeds safe integer range");
      }
      for (const [index, token] of tokens.entries()) {
        this.ctx.storage.sql.exec(
          "INSERT INTO tokens(lsn,value) VALUES(?,?)",
          state.tail + index + 1,
          token,
        );
      }
      this.ctx.storage.sql.exec("UPDATE buffer SET tail=? WHERE id=1", tail);
      this.notifyReaders();
      return tail;
    });
  }
  closeBuffer(fence: Fence, error: BufferState["error"]): Promise<Reply<void>> {
    return this.execute(() => {
      const state = this.writer(fence);
      if (state.completed) {
        return;
      }
      this.ctx.storage.sql.exec(
        "UPDATE buffer SET completed=1,error_name=?,error_message=? WHERE id=1",
        error?.name ?? null,
        error?.message.slice(0, 1024) ?? null,
      );
      this.notifyReaders();
    });
  }
  read(after: number, limit: number | null): Promise<Reply<{ tokens: string[]; lsn: number }>> {
    return this.execute(() => {
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        (limit !== null && (!Number.isSafeInteger(limit) || limit < 0))
      ) {
        throw new Error("Invalid response stream read bounds");
      }
      const state = this.requireState();
      const rows = this.ctx.storage.sql
        .exec<{ value: string }>(
          "SELECT value FROM tokens WHERE lsn>? ORDER BY lsn LIMIT ?",
          after,
          limit ?? -1,
        )
        .toArray();
      return { tokens: rows.map((row) => row.value), lsn: state.tail };
    });
  }
  latest(): Promise<Reply<{ token: string | null; lsn: number }>> {
    return this.execute(() => {
      const state = this.requireState();
      const row = this.ctx.storage.sql
        .exec<{ value: string }>("SELECT value FROM tokens WHERE lsn=?", state.tail)
        .toArray()[0];
      return { token: row?.value ?? null, lsn: state.tail };
    });
  }
  getEntry(): Promise<Reply<SessionEntry | null>> {
    return this.execute(() => {
      const row = this.ctx.storage.sql
        .exec<{ ref_count: number; created_at: number }>(
          "SELECT ref_count,created_at FROM registry WHERE id=1",
        )
        .toArray()[0];
      return row ? { refCount: row.ref_count, createdAt: row.created_at } : null;
    });
  }
  setEntry(entry: SessionEntry): Promise<Reply<void>> {
    return this.execute(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO registry(id,ref_count,created_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET ref_count=excluded.ref_count,created_at=excluded.created_at",
        entry.refCount,
        entry.createdAt,
      );
    });
  }
  removeEntry(): Promise<Reply<void>> {
    return this.execute(() => {
      this.ctx.storage.sql.exec("DELETE FROM registry");
    });
  }
  updateRefCount(delta: number): Promise<Reply<number>> {
    return this.execute(() => {
      if (!Number.isSafeInteger(delta)) {
        throw new Error("Reference delta must be an integer");
      }
      const row = this.ctx.storage.sql
        .exec<{ ref_count: number }>(
          "UPDATE registry SET ref_count=ref_count+? WHERE id=1 RETURNING ref_count",
          delta,
        )
        .toArray()[0];
      if (!row) {
        throw new Error("Session not found");
      }
      return row.ref_count;
    });
  }
}
