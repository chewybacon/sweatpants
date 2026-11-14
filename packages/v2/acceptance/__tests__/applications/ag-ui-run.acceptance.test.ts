import { EventType, type AGUIEvent } from "@ag-ui/core";
import { EventSchemas } from "@ag-ui/core/schemas";
import { expect, it, onTestFinished } from "vitest";
import {
  createAgUiRun,
  type AgUiRunEvent,
  type AgUiRunPublisher,
} from "@sweatpan.ts/protocols-ag-ui";
import { createLatch } from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime((runtime) => {
  for (const ending of ["parked", "plain", "failed", "cleanup-failed", "cancelled"] as const) {
    it(`${runtime.name}: AG-UI attempt projection ${ending}, joined cleanup and public data isolation`, async () => {
      type View = { state: string };
      const entered = createLatch<void>();
      const proceed = createLatch<void>();
      const cleaning = createLatch<void>();
      const release = createLatch<void>();
      let publisher: AgUiRunPublisher<View> | undefined;
      let closed = false;
      let projections = 0;
      const outcome = {
        type: "interrupt" as const,
        interrupts: [
          { id: "question-1", reason: "input_required", metadata: { state: "waiting" } },
          { id: "question-2", reason: "input_required", metadata: { state: "waiting" } },
        ],
      };
      const view = { state: "waiting" };
      const run = createAgUiRun(runtime, {
        threadId: "thread",
        runId: "attempt",
        errorMessage: "Public failure",
        outcome:
          ending === "plain"
            ? undefined
            : (result) => {
                expect(closed).toBe(true);
                expect(result).toBe("parked");
                projections++;
                return outcome;
              },
        *execute(publish: AgUiRunPublisher<View>) {
          publisher = publish;
          yield* runtime.composition.ensure(function* () {
            cleaning.resolve();
            yield* runtime.fromPromise(() => release.promise);
            closed = true;
            if (ending === "cleanup-failed") {
              throw new Error("Private provider cleanup failure");
            }
          });
          publish.text("Old");
          publish.text("Replacement");
          publish.text("Replacement text");
          publish.endText();
          publish.custom("view", view);
          view.state = "private mutation";
          entered.resolve();
          yield* runtime.fromPromise(() => proceed.promise);
          if (ending === "failed") {
            throw new Error("Private provider credential details");
          }
          return "parked";
        },
      });
      expect(publisher).toBeUndefined();
      const owner = runtime.start(() => run.run());
      void owner.result.catch(() => undefined);
      onTestFinished(async () => {
        proceed.resolve();
        release.resolve();
        await owner.cancel();
      });
      await entered.promise;
      let joined = false;
      const stopping =
        ending === "cancelled"
          ? owner.cancel().then(() => {
              joined = true;
            })
          : undefined;
      if (ending !== "cancelled") {
        proceed.resolve();
      }
      await cleaning.promise;
      expect(closed).toBe(false);
      expect(joined).toBe(false);
      release.resolve();
      if (stopping) {
        await stopping;
        expect(joined).toBe(true);
      } else if (ending === "failed" || ending === "cleanup-failed") {
        await expect(owner.result).rejects.toThrow("Private provider");
      } else {
        await expect(owner.result).resolves.toBe("parked");
      }
      expect(closed).toBe(true);
      expect(projections).toBe(ending === "parked" ? 1 : 0);
      outcome.interrupts[0]!.metadata.state = "private mutation";
      publisher!.text("late callback");
      publisher!.custom("late", { state: "ignored" });
      async function read() {
        return await runtime.start(function* () {
          const stream = yield* run.events();
          const result: AgUiRunEvent<View>[] = [];
          while (true) {
            const item = yield* stream.next();
            if (item.done) {
              return result;
            }
            result.push(item.value);
          }
        }).result;
      }
      const events = await read();
      const protocolEvents: AGUIEvent[] = events;
      for (const event of protocolEvents) {
        expect(EventSchemas.safeParse(event).success).toBe(true);
      }
      expect(events[0]).toEqual({ type: "RUN_STARTED", threadId: "thread", runId: "attempt" });
      expect(
        events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT).map((e) => e.delta),
      ).toEqual(["Old", "Replacement", " text"]);
      const starts = events.filter((e) => e.type === EventType.TEXT_MESSAGE_START);
      expect(starts).toHaveLength(2);
      expect(starts[0]!.messageId).not.toBe(starts[1]!.messageId);
      expect(events.filter((e) => e.type === EventType.TEXT_MESSAGE_END)).toHaveLength(2);
      expect(JSON.stringify(events)).not.toMatch(
        /Private provider|private mutation|late callback|ignored/,
      );
      const custom = events.find((e) => e.type === EventType.CUSTOM);
      expect(custom?.value).toEqual({ state: "waiting" });
      if (custom) {
        custom.value.state = "reader mutation";
      }
      expect((await read()).find((e) => e.type === EventType.CUSTOM)?.value.state).toBe("waiting");
      if (ending === "parked" || ending === "plain") {
        expect(events.at(-1)).toEqual({
          type: "RUN_FINISHED",
          threadId: "thread",
          runId: "attempt",
          outcome:
            ending === "parked"
              ? {
                  type: "interrupt",
                  interrupts: [
                    { id: "question-1", reason: "input_required", metadata: { state: "waiting" } },
                    { id: "question-2", reason: "input_required", metadata: { state: "waiting" } },
                  ],
                }
              : undefined,
        });
        const terminal = events.find((event) => event.type === EventType.RUN_FINISHED);
        if (terminal?.outcome?.type === "interrupt") {
          terminal.outcome.interrupts[0]!.id = "reader mutation";
          const secondTerminal = (await read()).find(
            (event) => event.type === EventType.RUN_FINISHED,
          );
          expect(secondTerminal?.outcome).toMatchObject({
            interrupts: [{ id: "question-1" }, { id: "question-2" }],
          });
        }
      } else {
        expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(false);
        if (ending === "failed" || ending === "cleanup-failed") {
          expect(events.at(-1)).toEqual({ type: "RUN_ERROR", message: "Public failure" });
        }
      }
      await expect(runtime.start(() => run.run()).result).rejects.toThrow("already started");
    });
  }

  for (const failure of ["projection", "clone"] as const) {
    it(`${runtime.name}: failed terminal ${failure} closes readers with a public error`, async () => {
      const original = new Error("Private projection details");
      const run = createAgUiRun(runtime, {
        threadId: "thread",
        errorMessage: "Public failure",
        *execute() {
          return "done";
        },
        outcome() {
          if (failure === "projection") {
            throw original;
          }
          return {
            type: "interrupt",
            interrupts: [{ id: "question", reason: "input_required", metadata: { invalid() {} } }],
          };
        },
      });
      const owner = runtime.start(() => run.run());
      if (failure === "projection") {
        await expect(owner.result).rejects.toBe(original);
      } else {
        await expect(owner.result).rejects.toMatchObject({ name: "DataCloneError" });
      }
      const events = await runtime.start(function* () {
        const source = yield* run.events();
        const result: AGUIEvent[] = [];
        while (true) {
          const item = yield* source.next();
          if (item.done) {
            return result;
          }
          result.push(item.value);
        }
      }).result;
      expect(events.map((event) => event.type)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
      expect(events.at(-1)).toEqual({ type: "RUN_ERROR", message: "Public failure" });
    });
  }
});

forEachRuntime((runtime) => {
  it(`${runtime.name}: typed publisher extensions preserve lifecycle ownership and detached delivery`, async () => {
    let publisher: AgUiRunPublisher<unknown> | undefined;
    const snapshot = { progress: { count: 1 } };
    const run = createAgUiRun(runtime, {
      threadId: "extended",
      errorMessage: "Public failure",
      *execute(publish) {
        publisher = publish;
        publish.event({
          type: EventType.TOOL_CALL_START,
          toolCallId: "call",
          toolCallName: "read",
        });
        publish.event({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: "call",
          delta: '{"path":"guide"}',
        });
        publish.event({ type: EventType.TOOL_CALL_END, toolCallId: "call" });
        publish.event({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "call",
          messageId: "result",
          role: "tool",
          content: '"done"',
        });
        publish.event({ type: EventType.STATE_SNAPSHOT, snapshot });
        snapshot.progress.count = 99;
        expect(() => {
          // @ts-expect-error Run lifecycle remains owned by createAgUiRun.
          publish.event({ type: EventType.RUN_ERROR, message: "forged" });
        }).toThrow("owned");
        return "done";
      },
    });
    await runtime.start(() => run.run()).result;
    publisher!.event({ type: EventType.TOOL_CALL_END, toolCallId: "late" });
    const events = await runtime.start(function* () {
      const stream = yield* run.events();
      const values: AGUIEvent[] = [];
      while (true) {
        const item = yield* stream.next();
        if (item.done) {
          return values;
        }
        values.push(EventSchemas.parse(item.value));
      }
    }).result;
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.STATE_SNAPSHOT,
      EventType.RUN_FINISHED,
    ]);
    expect(events.find((event) => event.type === EventType.STATE_SNAPSHOT)?.snapshot).toEqual({
      progress: { count: 1 },
    });
  });
});
