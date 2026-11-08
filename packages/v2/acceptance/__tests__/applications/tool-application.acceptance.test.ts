import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteJournalStore } from "@sweatpan.ts/storage-sqlite";
import { createNodeSqliteConnection, v8Serializer } from "@sweatpan.ts/storage-sqlite/node";
import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import { z } from "zod";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import {
  createToolApplication,
  createToolSession,
  defineTool,
  installElicitHandlers,
} from "@sweatpan.ts/tools";
import { createHostedRecovery, createSqliteJournalRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

const lookup = defineEffect({
  key: "tool-app.lookup/1",
  context: z.string(),
  response: z.string(),
});
const approve = defineEffect({
  key: "tool-app.approve/1",
  context: z.string(),
  response: z.boolean(),
});

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const placement of ["local", "serialized"] as const) {
    it(`${runtime.name} ${placement}: application commands preserve scoped drivers, middleware and admitted recovery`, async () => {
      let normalizations = 0;
      const tool = defineTool("tool-app/1")
        .parameters(
          z.string().transform((input) => {
            normalizations++;
            return { label: input.trim() };
          }),
        )
        .capabilities({ lookup })
        .elicits({ approve })
        .execute(function* ({ label }, ctx) {
          const found = yield* ctx.capabilities.lookup(label);
          if (!found.ok) {
            throw new Error("Lookup rejected");
          }
          const answer = yield* ctx.elicit("approve", found.value);
          if (!answer.ok) {
            throw new Error("Approval rejected");
          }
          return { label: found.value, approved: answer.value };
        });
      const store = createSqliteJournalRig<
        { label: string; approved: boolean },
        CapabilityRequest,
        unknown,
        string,
        unknown,
        Y
      >({ program: tool.id, equals: isDeepStrictEqual });
      onTestFinished(() => store.close());
      const identity = runtime.composition.createContext<string>("requester");
      const port = runtime.composition.createApi("directory", {
        *lookup(label: string) {
          return `default:${label}`;
        },
      });
      const acquired: string[] = [];
      const requesters: string[] = [];
      let opened = 0,
        closed = 0,
        delivered = 0,
        intercepted = 0,
        starts = 0;
      const app = createToolApplication(runtime, tool, {
        name: "approval-app",
        matches: isDeepStrictEqual,
        recovery:
          placement === "serialized"
            ? (options) => createHostedRecovery(runtime, options)
            : undefined,
        *open() {
          opened++;
          yield* runtime.composition.ensure(function* () {
            closed++;
          });
          return store.open();
        },
        *configure({ effects, acquisition, recovery }) {
          requesters.push(yield* identity.expect());
          yield* effects.install(lookup, function* (label) {
            delivered++;
            return { ok: true, value: yield* port.operations.lookup(label) };
          });
          yield* effects.api(lookup).around({
            *handle(args, next) {
              intercepted++;
              return yield* next(...args);
            },
          });
          yield* acquisition.around({
            *acquire([input], next) {
              expectTypeOf(input).toEqualTypeOf<{ label: string }>();
              acquired.push(input.label);
              return yield* next(input);
            },
          });
          yield* recovery.execution.around({
            *start(args, next) {
              starts++;
              return yield* next(...args);
            },
          });
        },
      });
      const first = await runtime.start(function* () {
        yield* identity.set("alice");
        yield* port.install({
          *lookup(label) {
            return `parent:${label}`;
          },
        });
        let admissions = 0;
        yield* app.around({
          *start(args, next) {
            admissions++;
            return yield* next(...args);
          },
        });
        const report = yield* runtime.composition.scoped(function* () {
          yield* port.install({
            *lookup(label) {
              return `child:${label}`;
            },
          });
          return yield* app.operations.start(store.id, "  card  ");
        });
        expect(admissions).toBe(1);
        expect(yield* port.operations.lookup("card")).toBe("parent:card");
        return report;
      }).result;
      expect(first.state).toBe("waiting");
      expect(delivered).toBe(1);
      expect(intercepted).toBe(1);
      expect(acquired).toEqual(["card"]);
      expect(opened).toBe(closed);
      const snapshot = await runtime.start(function* () {
        yield* identity.set("alice");
        return yield* app.operations.read(store.id);
      }).result;
      if (snapshot.status !== "running" || snapshot.interaction?.state !== "waiting") {
        throw new Error("Expected a parked question");
      }
      expect(snapshot.pending?.request.input).toBe("child:card");
      const grant = snapshot.interaction.grant;
      const accepted = await runtime.start(function* () {
        yield* identity.set("bob");
        return yield* app.operations.answer(store.id, grant, { ok: true, value: true });
      }).result;
      expect(accepted.duplicate).toBe(false);
      expect(acquired).toHaveLength(1); // acceptance does not advance a Guest
      store.reopen();
      const completed = await runtime.start(function* () {
        yield* identity.set("recovery-worker");
        yield* port.install({
          lookup(): never {
            throw new Error("Accepted work was redelivered");
          },
        });
        return yield* app.operations.run(store.id);
      }).result;
      expect(completed).toMatchObject({
        state: "completed",
        value: { label: "child:card", approved: true },
      });
      expect(normalizations).toBe(1);
      expect(delivered).toBe(1);
      expect(intercepted).toBe(1);
      expect(starts).toBe(2);
      expect(acquired).toEqual(["card", "card"]);
      expect(requesters).toEqual(["alice", "alice", "bob", "recovery-worker"]);
      expect(opened).toBe(closed);
      await expect(runtime.start(() => app.operations.read(store.id)).result).rejects.toThrow();
      expect(opened).toBe(closed); // configuration failure still closes its command scope
    });
  }

  it(`${runtime.name}: configured elicitation routing overrides the default wait and journal identity is checked`, async () => {
    const tool = defineTool("tool-app/server-answer/1")
      .parameters(z.object({}))
      .elicits({ approve })
      .execute(function* (_, ctx) {
        const reply = yield* ctx.elicit("approve", "continue?");
        if (!reply.ok) {
          throw new Error("Declined");
        }
        return reply.value;
      });
    const store = createSqliteJournalRig<boolean, CapabilityRequest, unknown, string, unknown, Y>({
      program: tool.id,
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    const app = createToolApplication(runtime, tool, {
      name: "server-answer",
      matches: isDeepStrictEqual,
      *open() {
        return store.open();
      },
      *configure({ host, effects }) {
        yield* installElicitHandlers(host, effects, tool, {
          *approve() {
            return { ok: true, value: true };
          },
        });
      },
    });
    expect(await runtime.start(() => app.operations.start(store.id, {})).result).toMatchObject({
      state: "completed",
      value: true,
    });
    await expect(
      runtime.start(() => app.operations.read("wrong-execution")).result,
    ).rejects.toThrow("does not match");
  });

  it(`${runtime.name}: direct sessions reject another program before answer validation or terminal reads`, async () => {
    const tool = defineTool("tool-app/original/1")
      .parameters(z.object({}))
      .elicits({ approve })
      .execute(function* (_, ctx) {
        const reply = yield* ctx.elicit("approve", "continue?");
        if (!reply.ok) {
          throw new Error("Declined");
        }
        return reply.value;
      });
    const wrongQuestion = defineEffect({
      key: approve.id,
      context: z.string(),
      response: z.string(),
    });
    const wrongTool = defineTool("tool-app/wrong/1")
      .parameters(z.object({}))
      .elicits({ approve: wrongQuestion })
      .execute(function* () {
        return true;
      });
    const store = createSqliteJournalRig<boolean, CapabilityRequest, unknown, string, unknown, Y>({
      program: tool.id,
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    const original = createToolSession(runtime, tool, {
      journal: store.open(),
      matches: isDeepStrictEqual,
    });
    let configured = 0;
    const wrong = createToolSession(runtime, wrongTool, {
      journal: store.open(),
      matches: isDeepStrictEqual,
      *configure() {
        configured++;
      },
    });
    await runtime.start(() => original.start({})).result;
    const waiting = await runtime.start(() => original.read()).result;
    if (waiting.interaction?.state !== "waiting") {
      throw new Error("Expected question");
    }
    const grant = waiting.interaction.grant;
    await expect(
      runtime.start(() => wrong.answer(grant, { ok: true, value: "not-a-boolean" })).result,
    ).rejects.toThrow("program does not match");
    await expect(runtime.start(() => wrong.start({})).result).rejects.toThrow(
      "program does not match",
    );
    await expect(runtime.start(() => wrong.run()).result).rejects.toThrow("program does not match");
    await expect(runtime.start(() => wrong.read()).result).rejects.toThrow(
      "program does not match",
    );
    const unchanged = await runtime.start(() => original.read()).result;
    expect(unchanged.revision).toBe(waiting.revision);
    expect(unchanged.frontier).toEqual(waiting.frontier);
    expect(unchanged.interaction).toEqual(waiting.interaction);
    expect(configured).toBe(0);
    await runtime.start(() => original.answer(grant, { ok: true, value: true })).result;
    expect(await runtime.start(() => original.run()).result).toMatchObject({
      state: "completed",
      value: true,
    });
    // Completion must not bypass the identity check merely because no Guest is acquired.
    await expect(runtime.start(() => wrong.run()).result).rejects.toThrow("program does not match");
    await expect(runtime.start(() => wrong.read()).result).rejects.toThrow(
      "program does not match",
    );
  });

  it(`${runtime.name}: application reads detach observations before their SQLite connection closes`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "tool-app-read-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "journal.sqlite");
    const connections: DatabaseSync[] = [];
    const tool = defineTool("tool-app/detached-read/1")
      .parameters(z.object({}))
      .elicits({ approve })
      .execute(function* (_, ctx) {
        const reply = yield* ctx.elicit("approve", "continue?");
        if (!reply.ok) {
          throw new Error("Declined");
        }
        return reply.value;
      });
    const app = createToolApplication(runtime, tool, {
      name: "detached-read",
      matches: isDeepStrictEqual,
      *open(execution) {
        const db = new DatabaseSync(path);
        connections.push(db);
        yield* runtime.composition.ensure(function* () {
          db.close();
        });
        return createSqliteJournalStore<boolean, CapabilityRequest, unknown, string, unknown, Y>({
          id: execution,
          program: tool.id,
          equals: isDeepStrictEqual,
          connection: createNodeSqliteConnection(db),
          serialization: {
            *resolve() {
              return v8Serializer;
            },
          },
        }).open();
      },
      *configure({ host, effects }) {
        yield* installElicitHandlers(host, effects, tool, {
          *approve() {
            return { ok: true, value: true };
          },
        });
      },
    });
    await runtime.start(() => app.operations.start("detached", {})).result;
    const snapshot = await runtime.start(() => app.operations.read("detached")).result;
    expect(snapshot).toMatchObject({ status: "completed", value: true, frontier: { position: 1 } });
    expect(snapshot).not.toHaveProperty("history");
    expectTypeOf<"history" extends keyof typeof snapshot ? true : false>().toEqualTypeOf<false>();
    expect(structuredClone(snapshot)).toEqual(snapshot);
    expect(connections).toHaveLength(2);
    for (const db of connections) {
      expect(() => db.prepare("SELECT 1")).toThrow();
    }
  });
});
