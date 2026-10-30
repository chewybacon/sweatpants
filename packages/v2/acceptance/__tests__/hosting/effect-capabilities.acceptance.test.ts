import {
  createHostedRecovery as createRecovery,
  createProtocolRig,
  createSqliteJournalRig,
} from "@sweatpan.ts/testing";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import { isDeepStrictEqual } from "node:util";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Work } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import { type Attempts } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  createHosting,
  installGuestRetention,
  createEffectCapabilities,
} from "@sweatpan.ts/hosting";

import { forEachRuntime } from "../runtime/assembly.ts";

// Real Standard Schema transformations, kept local to the acceptance application.
function textSchema<T>(transform: (text: string) => T): StandardSchemaV1<string, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "acceptance",
      validate(value) {
        return typeof value === "string"
          ? { value: transform(value) }
          : { issues: [{ message: "Expected text" }] };
      },
    },
  };
}

// These exact definition objects are shared by both runtime suites and every host below.
const sharedRead = defineEffect({
  key: "shared.read",
  context: textSchema((path) => ({ path })),
  response: textSchema((text) => ({ text })),
});
const sharedPath = defineEffect(
  { key: "shared.path", context: textSchema((path) => path) },
  function* (path) {
    return { ok: true, value: { path } };
  },
);

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution;
  }

  it(`${runtime.name}: module-level definitions keep implementations and middleware in host scopes`, async () => {
    const peer = createProtocolRig();
    function assemble(label?: string) {
      const effects = createEffectCapabilities(runtime, "shared-host");
      const ctx = effects.grant({ path: sharedPath, read: sharedRead });
      const store = createSqliteJournalRig<
        { text: string },
        CapabilityRequest,
        unknown,
        string,
        unknown,
        Y
      >({ program: "shared", equals: isDeepStrictEqual });
      onTestFinished(() => store.close());
      const journal = store.open();
      const recovery = createRecovery(runtime, {
        name: "shared-recovery",
        program: "shared",
        matches: isDeepStrictEqual,
        *acquire() {
          return createScopedGuest(function* () {
            const location = yield* ctx.capabilities.path("src/index.ts");
            if (!location.ok) {
              throw new Error("Unexpected path failure");
            }
            expectTypeOf(location.value).toEqualTypeOf<{ path: string }>();
            const result = yield* ctx.capabilities.read(location.value.path);
            if (!result.ok) {
              throw new Error("Unexpected read failure");
            }
            return result.value;
          });
        },
      });
      const host = createHosting(runtime.composition, {
        name: "shared-hosting",
        journal,
        recovery: recovery.operations,
        attempts: journal.attempts,
        handle: ctx.handle,
      });
      return start(function* () {
        yield* host.around(ctx.admission);
        yield* effects.install(sharedPath);
        if (label) {
          yield* effects.install(sharedRead, function* ({ path }) {
            const reply = yield* runtime.fromPromise((signal) =>
              peer.send({ id: label, token: path }, signal),
            );
            return { ok: true as const, value: reply.body };
          });
          yield* effects.api(sharedRead).around({
            *handle([input], next) {
              const outcome = yield* next(input);
              return outcome.ok ? { ok: true, value: `${label}:${outcome.value}` } : outcome;
            },
          });
        }
        return yield* host.operations.run();
      });
    }
    const a = assemble("A");
    const b = assemble("B");
    await Promise.race([peer.waitForRequests(2), Promise.all([a.result, b.result])]);
    peer.reply("B", { status: 200, body: "second" });
    peer.reply("A", { status: 200, body: "first" });
    await expect(a.result).resolves.toEqual({ state: "completed", value: { text: "A:first" } });
    await expect(b.result).resolves.toEqual({ state: "completed", value: { text: "B:second" } });
    // Previous installations cannot become defaults on the shared declaration.
    await expect(assemble().result).rejects.toThrow("Effect handler is not installed");
  });

  for (const lifetime of ["recover", "retain"] as const) {
    it(`${runtime.name} ${lifetime}: granted library-style and custom effects share scoped dispatch and replay accepted transformed values`, async () => {
      const effects = createEffectCapabilities(runtime, "research-effects");
      let acquisitions = 0;
      let disposals = 0;
      let parses = 0;
      let lookups = 0;
      let elicitCalls = 0;
      let outputParses = 0;
      let middlewareCalls = 0;
      const lookup = defineEffect(
        {
          key: "company.lookup",
          context: textSchema((text) => {
            parses++;
            return { domain: text.toLowerCase() };
          }),
        },
        function* ({ domain }) {
          lookups++;
          return { ok: true, value: { name: "Acme", domain } };
        },
      );
      const elicit = defineEffect({
        key: "elicit.market",
        context: textSchema((text) => text),
        response: textSchema((market) => {
          outputParses++;
          return { market };
        }),
      });
      const store = createSqliteJournalRig<
        { name: string; market: string },
        CapabilityRequest,
        unknown,
        string
      >({ program: "research", equals: isDeepStrictEqual });
      onTestFinished(() => store.close());
      const acknowledgement = createProtocolRig();

      function assemble(delay: boolean) {
        const journal = store.open();
        const grant = effects.grant({ lookup, elicit });
        const recovery = createRecovery(runtime, {
          name: "research-recovery",
          program: "research",
          matches: isDeepStrictEqual,
          *acquire() {
            acquisitions++;
            yield* runtime.composition.ensure(function* () {
              disposals++;
            });
            return createScopedGuest(function* () {
              const company = yield* grant.capabilities.lookup("ACME.EXAMPLE");
              if (!company.ok) {
                throw new Error("Unexpected lookup failure");
              }
              expectTypeOf(company.value).toEqualTypeOf<{ name: string; domain: string }>();
              const answer = yield* grant.capabilities.elicit("Which market?");
              if (!answer.ok) {
                throw new Error("Unexpected answer failure");
              }
              expectTypeOf(answer.value).toEqualTypeOf<{ market: string }>();
              return { name: company.value.name, market: answer.value.market };
            });
          },
        });
        const host = createHosting(runtime.composition, {
          name: "research-host",
          journal,
          recovery: recovery.operations,
          attempts: {
            begin: (...args) => journal.attempts.begin(...args),
            *settle(
              ...args: Parameters<Attempts<CapabilityRequest, unknown, string, Y>["settle"]>
            ) {
              const result = yield* journal.attempts.settle(...args);
              if (delay) {
                yield* runtime.fromPromise((signal) =>
                  acknowledgement.send({ id: "accepted", token: "lookup" }, signal),
                );
              }
              return result;
            },
          },
          *handle(request) {
            expect(acquisitions - disposals).toBe(lifetime === "retain" ? 1 : 0);
            return yield* grant.handle(request);
          },
        });
        return start(function* () {
          yield* host.around(grant.admission);
          if (lifetime === "retain") {
            yield* installGuestRetention(runtime.composition, host, recovery, journal);
          }
          yield* effects.install(lookup);
          yield* effects.install(elicit, function* () {
            elicitCalls++;
            return { ok: true, value: "Europe" };
          });
          yield* effects.api(lookup).around({
            *handle([input], next) {
              middlewareCalls++;
              expectTypeOf(input).toEqualTypeOf<{ domain: string }>();
              return yield* next(input);
            },
          });
          return yield* host.operations.run();
        });
      }
      const interrupted = assemble(true);
      await Promise.race([acknowledgement.waitForRequests(1), interrupted.result]);
      await interrupted.cancel();
      store.reopen();
      await expect(assemble(false).result).resolves.toEqual({
        state: "completed",
        value: { name: "Acme", market: "Europe" },
      });
      expect(acquisitions).toBe(lifetime === "retain" ? 2 : 3);
      expect(disposals).toBe(acquisitions);
      expect({ parses, lookups, elicitCalls, outputParses, middlewareCalls }).toEqual({
        parses: 1,
        lookups: 1,
        elicitCalls: 1,
        outputParses: 1,
        middlewareCalls: 1,
      });
    });
  }

  it(`${runtime.name}: declared exchanges rebind on recovery without revalidating accepted answers`, async () => {
    const peer = createProtocolRig();
    const acknowledgement = createProtocolRig();
    let validations = 0;
    let middlewareCalls = 0;
    const store = createSqliteJournalRig<
      { market: string; count: number },
      CapabilityRequest,
      unknown,
      string
    >({
      program: "declared-exchanges",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());

    function assemble(delay: boolean) {
      // Fresh definitions and schemas as well as a fresh database connection on recovery.
      const effects = createEffectCapabilities(runtime, "declared-exchanges");
      const market = textSchema((text) => {
        validations++;
        return { market: text.toUpperCase() };
      });
      const count = textSchema((text) => {
        validations++;
        return Number(text);
      });
      const chooseMarket = defineEffect({
        key: "chooseMarket",
        context: textSchema((text) => text),
        response: market,
      });
      const chooseCount = defineEffect({
        key: "chooseCount",
        context: textSchema((text) => text),
        response: count,
      });
      const grant = effects.grant({ market: chooseMarket, count: chooseCount });
      const journal = store.open();
      const recovery = createRecovery(runtime, {
        name: "declared-recovery",
        program: "declared-exchanges",
        matches: isDeepStrictEqual,
        *acquire() {
          return createScopedGuest(function* () {
            const answer = yield* grant.capabilities.market("market");
            const quantity = yield* grant.capabilities.count("count");
            if (!answer.ok) {
              throw new Error("Unexpected answer failure");
            }
            expectTypeOf(answer.value).toEqualTypeOf<{ market: string }>();
            if (!quantity.ok) {
              throw new Error("Unexpected count failure");
            }
            expectTypeOf(quantity.value).toEqualTypeOf<number>();
            return { market: answer.value.market, count: quantity.value };
          });
        },
      });
      const host = createHosting(runtime.composition, {
        name: "declared-host",
        journal,
        recovery: recovery.operations,
        attempts: {
          begin: (...args) => journal.attempts.begin(...args),
          *settle(...args: Parameters<Attempts<CapabilityRequest, unknown, string, Y>["settle"]>) {
            const result = yield* journal.attempts.settle(...args);
            if (delay) {
              yield* runtime.fromPromise((signal) =>
                acknowledgement.send({ id: "accepted", token: "market" }, signal),
              );
            }
            return result;
          },
        },
        handle: grant.handle,
      });
      return start(function* () {
        yield* host.around(grant.admission);
        function* answer(message: string) {
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id: message, token: "answer" }, signal),
          );
          return { ok: true as const, value: reply.body };
        }
        yield* effects.install(chooseMarket, answer);
        yield* effects.install(chooseCount, answer);
        for (const api of [effects.api(chooseMarket), effects.api(chooseCount)]) {
          yield* api.around({
            *handle([input], next) {
              middlewareCalls++;
              return yield* next(input);
            },
          });
        }
        return yield* host.operations.run();
      });
    }
    const first = assemble(true);
    await Promise.race([peer.waitForRequests(1), first.result]);
    peer.reply("market", { status: 200, body: "europe" });
    await Promise.race([acknowledgement.waitForRequests(1), first.result]);
    await first.cancel();
    store.reopen();
    const second = assemble(false);
    await Promise.race([peer.waitForRequests(2), second.result]);
    expect(peer.requests.map((request) => request.id)).toEqual(["market", "count"]);
    peer.reply("count", { status: 200, body: "3" });
    await expect(second.result).resolves.toEqual({
      state: "completed",
      value: { market: "EUROPE", count: 3 },
    });
    expect({ validations, middlewareCalls }).toEqual({ validations: 2, middlewareCalls: 2 });
  });

  it(`${runtime.name}: contextual recorded work and named exchanges share hosted recovery`, async () => {
    const peer = createProtocolRig();
    const acknowledgement = createProtocolRig();
    const store = createSqliteJournalRig<
      { path: string; text: string },
      CapabilityRequest,
      unknown,
      string,
      unknown,
      Y
    >({ program: "choose-file", equals: isDeepStrictEqual });
    onTestFinished(() => store.close());
    let draws = 0;
    let choices = 0;
    let transformations = 0;
    let reads = 0;

    function assemble(delay: boolean) {
      const effects = createEffectCapabilities(runtime, "file-exchanges");
      const choose = defineEffect({
        key: "chooseFile",
        context: textSchema((path) => ({ paths: [path] })),
        response: textSchema((path) => {
          transformations++;
          return { path };
        }),
      });
      const read = defineEffect(
        { key: "workspace.readFile", context: textSchema((path) => ({ path })) },
        function* ({ path }) {
          reads++;
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id: "read", token: path }, signal),
          );
          return { ok: true, value: { path, text: reply.body } };
        },
      );
      let current: ReturnType<typeof acquireContext> | undefined;
      function acquireContext() {
        return effects.grant({ choose, read }, { record: true });
      }
      const journal = store.open();
      const recovery = createRecovery(runtime, {
        name: "file-recovery",
        program: "choose-file",
        matches: isDeepStrictEqual,
        *acquire() {
          const ctx = acquireContext();
          yield* ctx.install();
          current = ctx;
          return createScopedGuest(function* () {
            const offered = yield* ctx.record(
              function* () {
                draws++;
                return { ok: true as const, value: { path: "src/main.ts" } };
              },
              { key: "recorded-operation" },
            );
            const selected = yield* ctx.capabilities.choose(offered.value.path);
            if (!selected.ok) {
              throw new Error("Unexpected choice failure");
            }
            const file = yield* ctx.capabilities.read(selected.value.path);
            if (!file.ok) {
              throw new Error("Unexpected read failure");
            }
            expectTypeOf(file.value).toEqualTypeOf<{ path: string; text: string }>();
            return file.value;
          });
        },
      });
      let settlements = 0;
      const host = createHosting(runtime.composition, {
        name: "file-host",
        journal,
        recovery: recovery.operations,
        attempts: {
          begin: (...args) => journal.attempts.begin(...args),
          *settle(...args: Parameters<Attempts<CapabilityRequest, unknown, string, Y>["settle"]>) {
            const result = yield* journal.attempts.settle(...args);
            settlements++;
            if (delay && settlements === 2) {
              yield* runtime.fromPromise((signal) =>
                acknowledgement.send({ id: "accepted-choice", token: "pause" }, signal),
              );
            }
            return result;
          },
        },
        *handle(request) {
          if (!current) {
            throw new Error("Guest has not been acquired");
          }
          return yield* current.handle(request);
        },
      });
      return start(function* () {
        yield* host.around({
          *child([pending], next) {
            if (!current) {
              throw new Error("Guest has not been acquired");
            }
            return yield* current.admission.child([pending], next);
          },
        });
        yield* effects.install(read);
        yield* effects.install(choose, function* ({ paths }) {
          choices++;
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id: "choose", token: paths.join(",") }, signal),
          );
          return { ok: true as const, value: reply.body };
        });
        yield* installGuestRetention(runtime.composition, host, recovery, journal);
        return yield* host.operations.run();
      });
    }
    const first = assemble(true);
    await Promise.race([peer.waitForRequests(1), first.result]);
    peer.reply("choose", { status: 200, body: "src/main.ts" });
    await Promise.race([acknowledgement.waitForRequests(1), first.result]);
    await first.cancel();
    store.reopen();
    const second = assemble(false);
    await Promise.race([peer.waitForRequests(2), second.result]);
    expect(peer.requests).toEqual([
      { id: "choose", token: "src/main.ts" },
      { id: "read", token: "src/main.ts" },
    ]);
    peer.reply("read", { status: 200, body: "export const answer = 42;" });
    await expect(second.result).resolves.toEqual({
      state: "completed",
      value: { path: "src/main.ts", text: "export const answer = 42;" },
    });
    expect({ draws, choices, transformations, reads }).toEqual({
      draws: 1,
      choices: 1,
      transformations: 1,
      reads: 1,
    });
  });

  for (const mode of ["failure", "exception", "bare"] as const) {
    it(`${runtime.name}: named ${mode} distinguishes authored results from delivery errors across reopen`, async () => {
      const peer = createProtocolRig();
      const acknowledgement = createProtocolRig();
      const store = createSqliteJournalRig<unknown, CapabilityRequest, unknown, string, unknown, Y>(
        {
          program: "named-outcome",
          equals: isDeepStrictEqual,
        },
      );
      onTestFinished(() => store.close());
      let calls = 0;
      let outputParses = 0;
      let settlements = 0;
      function assemble(pause: boolean) {
        const effects = createEffectCapabilities(runtime, "named-outcome");
        const lookup = defineEffect(
          {
            key: "lookup",
            context: textSchema((text) => text),
            response: textSchema((text) => {
              outputParses++;
              return { text };
            }),
          },
          function* (input) {
            calls++;
            const reply = yield* runtime.fromPromise((signal) =>
              peer.send({ id: "lookup", token: input }, signal),
            );
            if (mode === "bare") {
              // Models a JS handler violating its declared return contract.
              return 6 as unknown as { ok: true; value: string };
            }
            return { ok: false, error: { code: "not-found" as const, detail: reply.body } };
          },
        );
        const ctx = effects.grant({ lookup });
        const journal = store.open();
        const recovery = createRecovery(runtime, {
          name: "named-outcome-recovery",
          program: "named-outcome",
          matches: isDeepStrictEqual,
          *acquire() {
            return createScopedGuest(function* () {
              const result = yield* ctx.capabilities.lookup("missing.txt");
              if (!result.ok) {
                expectTypeOf(result.error).toEqualTypeOf<{ code: "not-found"; detail: string }>();
              }
              return result;
            });
          },
        });
        const host = createHosting(runtime.composition, {
          name: "named-outcome-host",
          journal,
          recovery: recovery.operations,
          attempts: {
            begin: (...args) => journal.attempts.begin(...args),
            *settle(...args: Parameters<typeof journal.attempts.settle>) {
              settlements++;
              const accepted = yield* journal.attempts.settle(...args);
              if (pause) {
                yield* runtime.fromPromise((signal) =>
                  acknowledgement.send({ id: "accepted", token: "pause" }, signal),
                );
              }
              return accepted;
            },
          },
          handle: ctx.handle,
        });
        return start(function* () {
          yield* host.around(ctx.admission);
          yield* effects.install(lookup);
          return yield* host.operations.run();
        });
      }
      const first = assemble(true);
      await Promise.race([peer.waitForRequests(1), first.result]);
      if (mode === "exception") {
        peer.fail("lookup", new Error("Transport failed"));
      } else {
        peer.reply("lookup", { status: 404, body: "missing.txt" });
      }
      if (mode === "failure") {
        await Promise.race([acknowledgement.waitForRequests(1), first.result]);
        await first.cancel();
        expect(settlements).toBe(1);
      } else {
        await expect(first.result).rejects.toThrow(
          mode === "exception" ? "Transport failed" : "Effect work must return an Outcome",
        );
        expect(settlements).toBe(0);
        expect((await start(() => store.open().read()).result).frontier.position).toBe(0);
      }
      store.reopen();
      const recovered = await assemble(false).result;
      if (mode === "failure") {
        expect(recovered).toEqual({
          state: "completed",
          value: { ok: false, error: { code: "not-found", detail: "missing.txt" } },
        });
      } else {
        expect(recovered.state).toBe("occupied");
      }
      expect(calls).toBe(1);
      expect(outputParses).toBe(0);
    });
  }

  for (const mode of ["execute", "wait", "child"] as const) {
    it(`${runtime.name}: admission denies an ungranted ${mode} route before delivery authority`, async () => {
      const effects = createEffectCapabilities(runtime, "denied-effects");
      let calls = 0;
      const secret = defineEffect(
        { key: "private.lookup", context: textSchema((text) => text) },
        function* (input) {
          calls++;
          return { ok: true, value: input };
        },
      );
      const grant = effects.grant({});
      const store = createSqliteJournalRig<string, CapabilityRequest, unknown, string, unknown, Y>({
        program: "forged",
        equals: isDeepStrictEqual,
      });
      onTestFinished(() => store.close());
      const journal = store.open();
      const recovery = createRecovery(runtime, {
        name: "forged-recovery",
        program: "forged",
        matches: isDeepStrictEqual,
        *acquire() {
          return createScopedGuest(function* () {
            const result = yield* secret.call("forged");
            if (!result.ok) {
              throw new Error("Unexpected secret failure");
            }
            return result.value;
          });
        },
      });
      const entered = { attempt: 0, participant: 0, child: 0, routing: 0 };
      const host = createHosting(runtime.composition, {
        name: "forged-host",
        journal,
        recovery: recovery.operations,
        attempts: {
          *begin(...args) {
            entered.attempt++;
            return yield* journal.attempts.begin(...args);
          },
          settle: (...args: Parameters<typeof journal.attempts.settle>) =>
            journal.attempts.settle(...args),
        },
        interactions: {
          request: journal.interactions.request,
          *register(...args) {
            entered.participant++;
            return yield* journal.interactions.register(...args);
          },
          answer: (...args: Parameters<typeof journal.interactions.answer>) =>
            journal.interactions.answer(...args),
          invalidate: (...args) => journal.interactions.invalidate(...args),
        },
        handle: grant.handle,
      });
      const execution = start(function* () {
        yield* effects.install(secret);
        // Earlier max middleware is outermost. Assembly deliberately selects this policy.
        yield* host.around(grant.admission);
        yield* host.around({
          *child([pending], next) {
            entered.routing++;
            if (mode !== "child") {
              return yield* next(pending);
            }
            entered.child++;
            const child = yield* journal.ensureChild<string, CapabilityRequest, unknown, string>(
              pending.id,
              {
                program: "forbidden-child",
                input: pending.request,
                outcome: (value) => ({ ok: true, value }),
              },
            );
            return {
              id: child.link.childId,
              *run() {
                return false;
              },
            };
          },
          *deliveryMode() {
            return mode === "wait" ? "wait" : "execute";
          },
        });
        return yield* host.operations.run();
      });
      await expect(execution.result).rejects.toThrow("Effect is not granted");
      expect(entered).toEqual({ attempt: 0, participant: 0, child: 0, routing: 0 });
      expect(calls).toBe(0);
      const before = await start(() => journal.read()).result;
      expect(before.status).toBe("running");
      expect(before.frontier.position).toBe(0);
      if (before.status === "running") {
        expect(before.children).toBeUndefined();
        expect(before.pending).toBeDefined();
      }
      // The rejected request remains parked, but unoccupied. Fresh authorized assembly
      // can fulfill that exact request after reopen without replacing any attempt.
      store.reopen();
      const reopened = store.open();
      const admitted = effects.grant({ secret });
      const allowed = createHosting(runtime.composition, {
        name: "authorized-host",
        journal: reopened,
        recovery: recovery.operations,
        attempts: reopened.attempts,
        handle: admitted.handle,
      });
      await expect(
        start(function* () {
          yield* effects.install(secret);
          yield* allowed.around(admitted.admission);
          return yield* allowed.operations.run();
        }).result,
      ).resolves.toEqual({ state: "completed", value: "forged" });
      expect(calls).toBe(1);
    });
  }
});
