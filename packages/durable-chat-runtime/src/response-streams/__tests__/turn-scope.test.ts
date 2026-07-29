import { createScope, run, suspend, useScope, type Operation } from "effection";
import { describe, expect, it } from "vitest";
import { definePort } from "@sweatpants/foundation/port";
import { createDurableTurnOwner } from "../owner.ts";
import { startOwnedTask } from "../owned-task.ts";

/**
 * Executable evidence for ADR-004.
 *
 * The production chat handler now installs per-Turn seams on a distinct Host
 * child. These probes retain the rejected shapes and certify the final owner.
 */

interface Seam {
  who(): Operation<string>;
}

const SeamPort = definePort<Seam>("adr-004-probe", {
  *who(): Operation<string> {
    throw new Error("no seam installed");
  },
});

describe("ADR-004: Host-owned Turn scope", () => {
  it("owns a writer that resolves Turn seams, survives a consumer, and tears down with the Turn", async () => {
    const [hostScope, destroyHost] = createScope();
    const registered: Array<{ isDone(): boolean; waitForDone(): Operation<unknown> }> = [];
    const events: string[] = [];
    const owner = await run(function* () {
      return yield* createDurableTurnOwner(
        { scope: hostScope, register: (work) => registered.push(work) },
        function* () {
          yield* SeamPort.installDriver({
            *who() {
              return "turn-provider";
            },
          });
        },
      );
    });

    await owner.scope.run(function* () {
      yield* startOwnedTask(
        function* () {
          try {
            events.push(yield* SeamPort.api.operations.who());
            yield* suspend();
          } finally {
            events.push("writer-torn-down");
          }
        },
        { ownerScope: owner.scope, register: owner.register },
      );
      const [consumer, destroyConsumer] = createScope(owner.scope);
      yield* consumer.run(function* () {
        events.push("consumer-open");
      });
      yield* destroyConsumer();
    });

    owner.seal();
    expect(events).toEqual(expect.arrayContaining(["turn-provider", "consumer-open"]));
    expect(owner.isDone()).toBe(false);
    expect(registered).toHaveLength(1);
    await run(() => owner.abort());
    expect(events).toEqual(
      expect.arrayContaining(["turn-provider", "consumer-open", "writer-torn-down"]),
    );
    expect(owner.isDone()).toBe(true);
    await destroyHost();
  });
  it("fails closed when the writer scope has no parent", async () => {
    const [appScope, destroyApp] = createScope();
    const failure = await appScope.run(function* () {
      // Stand in for the request scope installing the per-Turn provider.
      yield* SeamPort.installDriver({
        *who() {
          return "request-provider";
        },
      });

      // Low-level standalone composition may use an owner-less child scope.
      const [writerScope, destroyWriter] = createScope();
      try {
        return yield* writerScope.run(function* (): Operation<string> {
          try {
            return yield* SeamPort.api.operations.who();
          } catch (error) {
            return (error as Error).message;
          }
        });
      } finally {
        yield* destroyWriter();
      }
    });

    // This is the exact break that forced `bind` into the handler: the writer is
    // not below the installer, so lookup finds nothing.
    expect(failure).toBe("no seam installed");
    await destroyApp();
  });

  it("resolves without bind when the writer descends from a Turn scope", async () => {
    const [appScope, destroyApp] = createScope();

    // The Turn scope is a child of the application scope, so it survives the
    // request that opened it and still inherits application configuration.
    const [turnScope, destroyTurn] = createScope(appScope);

    const observed = await turnScope.run(function* () {
      // The per-Turn seam is installed on the Turn, not on the request.
      yield* SeamPort.installDriver({
        *who() {
          return "turn-provider";
        },
      });

      const [writerScope, destroyWriter] = createScope(yield* useScope());
      try {
        return yield* writerScope.run(function* (): Operation<string> {
          return yield* SeamPort.api.operations.who();
        });
      } finally {
        yield* destroyWriter();
      }
    });

    expect(observed).toBe("turn-provider");
    await destroyTurn();
    await destroyApp();
  });

  it("keeps the writer alive after the request scope ends", async () => {
    const [appScope, destroyApp] = createScope();
    const [turnScope, destroyTurn] = createScope(appScope);

    const writerRan: string[] = [];
    await turnScope.run(function* () {
      yield* SeamPort.installDriver({
        *who() {
          return "turn-provider";
        },
      });
      const turn = yield* useScope();

      // A request scope opened and closed beneath the Turn.
      const [requestScope, destroyRequest] = createScope(turn);
      yield* requestScope.run(function* () {
        writerRan.push("request-open");
      });
      yield* destroyRequest();

      // The writer starts after the request is gone and still resolves, which is
      // the durability property the orphan scope was protecting.
      const [writerScope, destroyWriter] = createScope(turn);
      writerRan.push(
        yield* writerScope.run(function* (): Operation<string> {
          return yield* SeamPort.api.operations.who();
        }),
      );
      yield* destroyWriter();
    });

    expect(writerRan).toEqual(["request-open", "turn-provider"]);
    await destroyTurn();
    await destroyApp();
  });

  it("tears the writer down when the Turn scope is destroyed", async () => {
    const [appScope, destroyApp] = createScope();
    const [turnScope, destroyTurn] = createScope(appScope);
    const events: string[] = [];

    const [writerScope] = createScope(turnScope);
    void writerScope.run(function* () {
      try {
        events.push("writer-started");
        yield* suspend();
      } finally {
        events.push("writer-torn-down");
      }
    });

    await run(function* () {
      // Yield once so the writer reaches its suspend point.
      yield* useScope();
    });
    expect(events).toEqual(["writer-started"]);

    // Destroying the Turn reclaims the writer: no orphan survives the Turn, which
    // is what the parentless scope cannot guarantee today.
    await destroyTurn();
    expect(events).toEqual(["writer-started", "writer-torn-down"]);
    await destroyApp();
  });
});
