// Workerd fixture: one Durable Object hosts one journal tree in its own SQLite storage.
import type { Operation, Outcome } from "@standard-durability/core";
import { createRecovery } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createHosting } from "@sweatpan.ts/hosting";
import { createRuntime as createEffectRuntime } from "@sweatpan.ts/runtime-effect";
import { createRuntime as createEffectionRuntime } from "@sweatpan.ts/runtime-effection";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { Serializer } from "@sweatpan.ts/storage";
import {
  createDurableObjectSqliteConnection,
  createSqliteJournalStore,
  type DurableObjectSqlStorage,
} from "@sweatpan.ts/storage-sqlite";
const PROGRAM = "do:sample-approval:v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const json: Serializer = {
  format: "json:1",
  encode: (value) => encoder.encode(JSON.stringify(value)),
  decode: (bytes) => JSON.parse(decoder.decode(bytes)) as unknown,
};
const equals = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
// Minimal structural Workers types; the fixture avoids a workers-types dependency.
type Namespace = {
  idFromName(name: string): unknown;
  get(id: unknown): {
    fetch(r: Request): Promise<Response>;
  };
};
export class Conversation {
  constructor(
    private readonly ctx: {
      storage: unknown;
    },
  ) {}
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const runtime: Runtime<any> =
      url.searchParams.get("runtime") === "effect"
        ? createEffectRuntime()
        : createEffectionRuntime();
    return Response.json(await runtime.start(() => this.handle(runtime, url)).result);
  }
  *handle<Y>(runtime: Runtime<Y>, url: URL): Operation<unknown, Y> {
    const storage = this.ctx.storage as unknown as DurableObjectSqlStorage & {
      sql: {
        exec(
          sql: string,
          ...params: unknown[]
        ): {
          toArray(): unknown[];
        };
      };
    };
    storage.sql.exec("CREATE TABLE IF NOT EXISTS fixture_deliveries (request TEXT)");
    const journal = createSqliteJournalStore<string, string, string, string, unknown, Y>({
      connection: createDurableObjectSqliteConnection(storage),
      id: "conversation",
      program: PROGRAM,
      equals,
      serialization: {
        *resolve() {
          return json;
        },
      },
    }).open();
    if (url.pathname === "/admit") {
      yield* journal.admit(PROGRAM, url.searchParams.get("input"));
    }
    if (url.pathname === "/answer") {
      const snapshot = yield* journal.read();
      if (snapshot.interaction?.state !== "waiting") {
        throw new Error("Expected a waiting interaction");
      }
      yield* journal.interactions.answer(snapshot.interaction.grant, {
        ok: true,
        value: url.searchParams.get("value")!,
      });
    }
    if (url.pathname === "/read") {
      const snapshot = yield* journal.read();
      const deliveries = storage.sql.exec("SELECT request FROM fixture_deliveries").toArray();
      return { status: snapshot.status, deliveries: deliveries.length };
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
        return { ok: true, value: "finding" };
      },
    });
    yield* host.around({
      operations: {
        deliveryMode: () =>
          function* (request) {
            return request === "approval" ? "wait" : "execute";
          },
      },
    });
    const result = yield* host.operations.run();
    return result.state === "completed" ? result : { state: result.state };
  }
}
export default {
  fetch(
    request: Request,
    env: {
      CONVERSATIONS: Namespace;
    },
  ): Promise<Response> {
    const url = new URL(request.url);
    const stub = env.CONVERSATIONS.get(
      env.CONVERSATIONS.idFromName(url.searchParams.get("id") ?? "default"),
    );
    return stub.fetch(request);
  },
};
