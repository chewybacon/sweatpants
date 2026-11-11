import { EventType } from "@ag-ui/core";
import { createBufferedSignal, type Runtime } from "@sweatpan.ts/runtime";
import type { AgUiRun, AgUiRunEvent, AgUiRunOptions, AgUiRunPublisher } from "./contracts.ts";

/** Construct a lazy, explicit owner with independent event readers. No scheduling,
 * persistence, authoring-loop policy or durable cancellation is implied. */
export function createAgUiRun<R, V, Y>(
  runtime: Runtime<Y>,
  options: AgUiRunOptions<R, V, Y>,
): AgUiRun<R, V, Y> {
  const events = createBufferedSignal<AgUiRunEvent<V>, void, Y>(runtime);
  let started = false;
  return {
    events: (offset = 0) => ({
      *[Symbol.iterator]() {
        const source = yield* events.from(offset);
        return {
          *next() {
            const item = yield* source.next();
            return item.done ? item : { done: false as const, value: structuredClone(item.value) };
          },
        };
      },
    }),
    *run(signal = new AbortController().signal) {
      if (started) {
        throw new Error("AG-UI run already started");
      }
      started = true;
      return yield* runtime.composition.scoped(function* () {
        let active = true;
        let began = false;
        let terminal = false;
        let textId: string | undefined;
        let lastText = "";
        yield* runtime.composition.ensure(function* () {
          // Native scope/cleanup failures may bypass a generator catch. Publish
          // the public fallback only after those resources have unwound.
          if (began && !terminal) {
            if (textId) {
              events.send({ type: EventType.TEXT_MESSAGE_END, messageId: textId });
            }
            terminal = true;
            events.send({ type: EventType.RUN_ERROR, message: options.errorMessage });
          }
          active = false;
          events.close();
        });
        const publish: AgUiRunPublisher<V> = {
          text(text) {
            if (!active) {
              return;
            }
            if (!textId || !text.startsWith(lastText)) {
              publish.endText();
              textId = crypto.randomUUID();
              events.send({
                type: EventType.TEXT_MESSAGE_START,
                messageId: textId,
                role: "assistant",
              });
            }
            const delta = text.slice(lastText.length);
            lastText = text;
            if (delta) {
              events.send({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: textId, delta });
            }
          },
          endText() {
            if (!active) {
              return;
            }
            if (textId) {
              events.send({ type: EventType.TEXT_MESSAGE_END, messageId: textId });
            }
            textId = undefined;
            lastText = "";
          },
          custom(name, value) {
            if (active) {
              events.send({ type: EventType.CUSTOM, name, value: structuredClone(value) });
            }
          },
        };
        return yield* runtime.withSignal(signal, function* () {
          const runId = options.runId ?? crypto.randomUUID();
          began = true;
          events.send({ type: EventType.RUN_STARTED, threadId: options.threadId, runId });
          try {
            // Publish terminal success only after command-owned cleanup has joined.
            const result = yield* runtime.composition.scoped(() => options.execute(publish));
            const outcome = structuredClone(options.outcome?.(result));
            publish.endText();
            active = false;
            terminal = true;
            events.send({
              type: EventType.RUN_FINISHED,
              threadId: options.threadId,
              runId,
              // CONDITIONAL-SPREAD: An absent projection must omit the optional wire field.
              ...(outcome === undefined ? {} : { outcome }),
            });
            return result;
          } catch (error) {
            publish.endText();
            active = false;
            terminal = true;
            events.send({ type: EventType.RUN_ERROR, message: options.errorMessage });
            throw error;
          }
        });
      });
    },
  };
}
