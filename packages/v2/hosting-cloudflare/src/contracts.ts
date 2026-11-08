import type { Api, Operation } from "@standard-durability/core";
import type { JournalBindingOptions, OwnedJournal } from "@sweatpan.ts/durable";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { Serializer } from "@sweatpan.ts/storage";
import type { DurableObjectSqlStorage } from "@sweatpan.ts/storage-sqlite";

/** Structural subset of Cloudflare `DurableObjectStorage` the host needs. */
export interface DurableObjectHostStorage extends DurableObjectSqlStorage {
  setAlarm(scheduledTime: number): Promise<void>;
}

/** Cloudflare's `alarm(alarmInfo)` argument. */
export interface AlarmInvocation {
  readonly retryCount: number;
  readonly isRetry: boolean;
}

/** One alarm run as seen by middleware. */
export interface AlarmRun<R, Q, V, E, Frame, Y> {
  readonly journal: OwnedJournal<R, Q, V, E, unknown, Y>;
  readonly emit: (frame: Frame) => void;
  readonly invocation: AlarmInvocation;
}

/** How one alarm run ended; failure has already failed the frame buffer. */
export type AlarmOutcome<Result> =
  | { readonly ok: true; readonly value: Result }
  | { readonly ok: false; readonly error: unknown };

/** Interceptable per-alarm operations. Middleware is installed per run. */
export interface DurableObjectHostMethods<R, Q, V, E, Frame, Result, Y> {
  /** Drive the program once. The default is the application's `advance` option. */
  advance(run: AlarmRun<R, Q, V, E, Frame, Y>): Operation<Result, Y>;
  /**
   * Decide the alarm's fate. The default rethrows failures so Cloudflare retries the
   * alarm. Returning normally ends the alarm without a retry.
   */
  settle(outcome: AlarmOutcome<Result>, run: AlarmRun<R, Q, V, E, Frame, Y>): Operation<void, Y>;
}

/** One Durable Object owns one journal tree and advances it from its alarm. */
export interface DurableObjectHostOptions<
  R,
  Q,
  V,
  E,
  Frame,
  Result,
  Y,
> extends JournalBindingOptions {
  readonly runtime: Runtime<Y>;
  /** Usually `ctx.storage`. The journal shares its SQLite database and transactions. */
  readonly storage: DurableObjectHostStorage;
  /** Root identity within this object's database. Defaults to `"root"`. */
  readonly id?: string;
  /** Workers have no V8 serializer; supply a portable format such as JSON. */
  readonly serializer: Serializer;
  /**
   * Drive the program once against a fresh journal binding. Install hosting here and
   * return when it completes, parks or yields. Emitted frames are provisional and live
   * only in memory; accepted state must be read from the journal.
   */
  advance(
    journal: OwnedJournal<R, Q, V, E, unknown, Y>,
    emit: (frame: Frame) => void,
  ): Operation<Result, Y>;
}

/** Program host bound to one Durable Object instance. */
export interface DurableObjectHost<R, Q, V, E, Frame, Result, Y> extends Api<
  DurableObjectHostMethods<R, Q, V, E, Frame, Result, Y>,
  Y
> {
  /** Fresh journal binding for commands such as admit, answer and read. */
  journal(): OwnedJournal<R, Q, V, E, unknown, Y>;
  /**
   * Request advancement after accepted input. Opens a pending frame buffer so readers
   * can attach before work starts; repeated wakes before dispatch share that buffer.
   * A wake during a run prepares the next run's buffer. Sets an immediate alarm and
   * returns once it is set; no client needs to stay connected.
   */
  wake(): Promise<void>;
  /**
   * Call from the object's `alarm(alarmInfo)` handler. Each run is a fresh execution:
   * `install` runs first in that scope, so middleware applies to this run only. The
   * result closes the frame buffer and failure fails it; `settle` then decides retry.
   * Each run consumes a pending buffer or opens a fresh one, including on retry.
   * Existing readers retain their original run's frames and terminal outcome.
   */
  alarm(
    invocation?: AlarmInvocation,
    install?: (host: DurableObjectHost<R, Q, V, E, Frame, Result, Y>) => Operation<void, Y>,
  ): Promise<void>;
  /**
   * Lazy, pull-driven frames from the current activation, starting at offset.
   * Compaction merges frames produced while the reader was slow. Undefined when no
   * activation has been requested since this instance started (for example after
   * eviction); read the journal instead.
   */
  events(
    offset?: number,
    compact?: (previous: Frame, next: Frame) => Frame | undefined,
  ): ReadableStream<Frame> | undefined;
}
