// Workerd fixture: an application Durable Object assembled from createDurableObjectHost.
import type { Operation, Outcome } from "@standard-durability/core";
import { createRecovery } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createHosting } from "@sweatpan.ts/hosting";
import {
  createDurableObjectHost,
  installAlarmRetryLimit,
  type AlarmInvocation,
  type DurableObjectHost,
  type DurableObjectHostStorage,
} from "@sweatpan.ts/hosting-cloudflare";
import { createRuntime as createEffectRuntime } from "@sweatpan.ts/runtime-effect";
import { createRuntime as createEffectionRuntime } from "@sweatpan.ts/runtime-effection";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { Serializer } from "@sweatpan.ts/storage";

const PROGRAM = "do:alarm-sample-approval:v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const json: Serializer = {
  format: "json:1",
  encode: (value) => encoder.encode(JSON.stringify(value)),
  decode: (bytes) => JSON.parse(decoder.decode(bytes)) as unknown,
};
const equals = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

type Storage = DurableObjectHostStorage & {
  sql: { exec(sql: string, ...params: unknown[]): { toArray(): Record<string, unknown>[] } };
};
type Namespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};
type Host = DurableObjectHost<string, string, string, string, string, string, any>;

function assemble<Y>(runtime: Runtime<Y>, storage: Storage) {
  storage.sql.exec("CREATE TABLE IF NOT EXISTS fixture_deliveries (request TEXT)");
  return createDurableObjectHost<string, string, string, string, string, string, Y>({
    runtime,
    storage,
    program: PROGRAM,
    equals,
    serializer: json,
    *advance(journal, emit) {
      // Fixture fault: fail the whole run, as an unavailable dependency would.
      if (storage.sql.exec("SELECT value FROM fixture_meta WHERE key='fail'").toArray()[0]) {
        throw new Error("dependency unavailable");
      }
      const recovery = createRecovery<string, string, Y, string, string>(runtime.composition, {
        name: "do-recovery",
        program: PROGRAM,
        matches: equals,
        *acquire() {
          return createScopedGuest(function* () {
            const sample: unknown = yield "sample";
            const approval: unknown = yield "approval";
            return `${String(sample)}:${String(approval)}`;
          });
        },
      });
      const host = createHosting(runtime.composition, {
        name: "do-host",
        journal,
        recovery: recovery.operations,
        attempts: journal.attempts,
        interactions: journal.interactions,
        *handle(request: string): Operation<Outcome<string, string>, Y> {
          storage.sql.exec("INSERT INTO fixture_deliveries VALUES (?)", request);
          // Provisional token deltas, produced at the effect's own pace.
          for (const delta of ["fin", "di", "ng"]) {
            emit(`delta:${delta}`);
            yield* runtime.sleep(20);
          }
          return { ok: true, value: "finding" };
        },
      });
      yield* host.around({
        *deliveryMode([request]) {
          return request === "approval" ? "wait" : "execute";
        },
      });
      const result = yield* host.operations.run();
      emit(`state:${result.state}`);
      return result.state;
    },
  });
}

export class Conversation {
  private readonly storage: Storage;
  private host: Host | undefined;

  constructor(ctx: { storage: unknown }) {
    this.storage = ctx.storage as Storage;
  }

  // The runtime choice is a fixture parameter, persisted so a restarted alarm uses it.
  private bind(name?: string | null): Host {
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS fixture_meta (key TEXT PRIMARY KEY, value TEXT)",
    );
    if (name) {
      this.storage.sql.exec(
        "INSERT INTO fixture_meta VALUES ('runtime', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        name,
      );
    }
    const stored = this.storage.sql
      .exec("SELECT value FROM fixture_meta WHERE key='runtime'")
      .toArray()[0]?.value;
    return (this.host ??= assemble(
      (stored === "effect" ? createEffectRuntime() : createEffectionRuntime()) as Runtime<any>,
      this.storage,
    ) as Host);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const host = this.bind(url.searchParams.get("runtime"));
    if (url.pathname === "/frame-lifecycle") {
      const runtime = (
        url.searchParams.get("runtime") === "effect"
          ? createEffectRuntime()
          : createEffectionRuntime()
      ) as Runtime<any>;
      const retry = url.searchParams.get("scenario") === "retry";
      let runs = 0;
      let scheduled = 0;
      // Control dispatch explicitly to exercise multiple wakes before one alarm,
      // and a retry on the same instance. SQLite and streams still run in workerd.
      const lifecycle = createDurableObjectHost({
        runtime,
        storage: {
          sql: this.storage.sql,
          transactionSync: (work) => this.storage.transactionSync(work),
          async setAlarm() {
            scheduled++;
          },
        },
        id: "frame-lifecycle",
        program: PROGRAM,
        equals,
        serializer: json,
        *advance(_journal, emit) {
          runs++;
          if (retry && runs === 1) {
            throw new Error("transient");
          }
          emit("recovered");
          return "done";
        },
      });
      await lifecycle.wake();
      const reader = lifecycle.events()!.getReader();
      const firstRead = reader.read().then(
        (value) => ({ value }),
        (error: unknown) => ({ error: String(error) }),
      );
      let failure: string | undefined;
      if (retry) {
        try {
          await lifecycle.alarm();
        } catch (error) {
          failure = String(error);
        }
        await lifecycle.alarm({ retryCount: 1, isRetry: true });
      } else {
        await lifecycle.wake();
        await lifecycle.alarm();
      }
      const first = await firstRead;
      const terminal = retry ? undefined : await reader.read();
      reader.releaseLock();
      const current = lifecycle.events()!.getReader();
      const frame = await current.read();
      const end = await current.read();
      current.releaseLock();
      return Response.json({ first, terminal, frame, end, failure, runs, scheduled });
    }
    if (url.pathname === "/events") {
      const events = host.events(Number(url.searchParams.get("offset") ?? 0), (previous, next) =>
        previous.startsWith("delta:") && next.startsWith("delta:")
          ? previous + next.slice("delta:".length)
          : undefined,
      );
      if (!events) {
        return new Response(null, { status: 204 });
      }
      return new Response(events.pipeThrough(lines()), {
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.pathname === "/fail") {
      this.storage.sql.exec(
        "INSERT INTO fixture_meta VALUES ('fail', '1') ON CONFLICT(key) DO NOTHING",
      );
      await host.wake();
      return Response.json({ accepted: true });
    }
    if (url.pathname === "/alarms") {
      this.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_alarms (retry INTEGER, outcome TEXT, error TEXT)",
      );
      return Response.json(this.storage.sql.exec("SELECT * FROM fixture_alarms").toArray());
    }
    const runtime: Runtime<any> = createEffectionRuntime();
    const journal = host.journal();
    if (url.pathname === "/admit") {
      await runtime.start(() => journal.admit(PROGRAM, url.searchParams.get("input"))).result;
      await host.wake();
      return Response.json({ accepted: true });
    }
    if (url.pathname === "/answer") {
      await runtime.start(function* () {
        const snapshot = yield* journal.read();
        if (snapshot.interaction?.state !== "waiting") {
          throw new Error("Expected a waiting interaction");
        }
        yield* journal.interactions.answer(snapshot.interaction.grant, {
          ok: true,
          value: url.searchParams.get("value")!,
        });
      }).result;
      await host.wake();
      return Response.json({ accepted: true });
    }
    const snapshot = await runtime.start(() => journal.read()).result;
    const deliveries = this.storage.sql.exec("SELECT request FROM fixture_deliveries").toArray();
    return Response.json({
      status: snapshot.status,
      waiting: snapshot.status === "running" && snapshot.interaction?.state === "waiting",
      value: snapshot.status === "completed" ? snapshot.value : undefined,
      deliveries: deliveries.length,
    });
  }

  async alarm(info?: AlarmInvocation): Promise<void> {
    const storage = this.storage;
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS fixture_alarms (retry INTEGER, outcome TEXT, error TEXT)",
    );
    await this.bind().alarm(info, function* (host) {
      // Application tracing of each alarm run's outcome.
      yield* host.around({
        *settle([outcome, run], next) {
          storage.sql.exec(
            "INSERT INTO fixture_alarms VALUES (?, ?, NULL)",
            run.invocation.retryCount,
            outcome.ok ? "ok" : "failed",
          );
          return yield* next(outcome, run);
        },
      });
      yield* installAlarmRetryLimit(host, 1, function* (error) {
        storage.sql.exec(
          "INSERT INTO fixture_alarms VALUES (?, 'exhausted', ?)",
          info?.retryCount ?? 0,
          String(error),
        );
      });
    });
  }
}

function lines() {
  return new TransformStream<string, Uint8Array>({
    transform(frame, controller) {
      controller.enqueue(encoder.encode(`${frame}\n`));
    },
  });
}

export default {
  fetch(request: Request, env: { CONVERSATIONS: Namespace }): Promise<Response> {
    const url = new URL(request.url);
    const stub = env.CONVERSATIONS.get(
      env.CONVERSATIONS.idFromName(url.searchParams.get("id") ?? "default"),
    );
    return stub.fetch(request);
  },
};
