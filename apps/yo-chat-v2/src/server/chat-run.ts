import type { DatabaseSync } from "node:sqlite";
import { createBufferedSignal, type Runtime } from "@sweatpan.ts/runtime";
import type { ChatSampling } from "@sweatpan.ts/chat";
import { type ChatCommand, type ChatView } from "../chat/contract.ts";
import { createDemoConversation } from "./chat-conversation.ts";
import type { ChatDemo } from "./chat-demo.ts";
import { readDemoTurn } from "./chat-view.ts";

/** App-local AG-UI-shaped events; this is not a general protocol adapter. */
export type ChatRunEvent =
  | { type: "RUN_STARTED" | "RUN_FINISHED"; threadId: string; runId: string }
  | { type: "TEXT_MESSAGE_START"; messageId: string; role: "assistant" }
  | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "TEXT_MESSAGE_END"; messageId: string }
  | { type: "CUSTOM"; name: string; value: ChatView }
  | { type: "RUN_ERROR"; message: string };

/** One explicit command owner, independent stream readers. Construction starts no work.
 * Retention is in-memory for this attempt only; offsets are not durable run cursors.
 * Reopening the conversation reconstructs accepted state from SQLite instead.
 * A parked command finishes this attempt stream, not the durable turn.
 */
export function createDemoRun<Y>(
  demo: ChatDemo,
  runtime: Runtime<Y>,
  openDatabase: () => DatabaseSync,
  sampling: (publish: (text: string) => void) => Promise<ChatSampling<Y>>,
  thread: string,
  command?: ChatCommand,
) {
  const events = createBufferedSignal<ChatRunEvent, void, Y>(runtime);
  let started = false;
  return {
    events: (offset = 0) => events.from(offset),
    *run(signal = new AbortController().signal) {
      if (started) {
        throw new Error("Chat run already started");
      }
      started = true;
      let active = true;
      // Registered before DB cleanup: close readers only after resources unwind.
      yield* runtime.composition.ensure(function* () {
        active = false;
        events.close();
      });
      return yield* runtime.withSignal(signal, function* () {
        const runId = crypto.randomUUID();
        let textId: string | undefined;
        let lastText = "";
        events.send({ type: "RUN_STARTED", threadId: thread, runId });
        try {
          const provider: ChatSampling<Y> = command
            ? yield* runtime.fromPromise(() =>
                sampling((text) => {
                  if (!active) {
                    return;
                  }
                  if (!textId || !text.startsWith(lastText)) {
                    if (textId) {
                      events.send({ type: "TEXT_MESSAGE_END", messageId: textId });
                    }
                    textId = crypto.randomUUID();
                    lastText = "";
                    events.send({
                      type: "TEXT_MESSAGE_START",
                      messageId: textId,
                      role: "assistant",
                    });
                  }
                  const delta = text.slice(lastText.length);
                  lastText = text;
                  if (delta) {
                    events.send({ type: "TEXT_MESSAGE_CONTENT", messageId: textId, delta });
                  }
                }),
              )
            : {
                *sample() {
                  throw new Error("Read cannot sample");
                },
              };
          const db = openDatabase();
          yield* runtime.composition.ensure(function* () {
            db.close();
          });
          const conversation = createDemoConversation(demo, runtime, db, thread, provider);
          if (command?.type === "message") {
            const admitted = yield* conversation.submit(command);
            yield* conversation.turn(admitted.execution).run();
          } else if (command?.type === "answer") {
            const turn = conversation.turn(command.root);
            const questions = yield* turn.interactions();
            while (true) {
              const item = yield* questions.next();
              if (item.done) {
                break;
              }
              if (
                item.value.execution === command.execution &&
                item.value.grant.requestId === command.grant.requestId
              ) {
                demo.validateAnswer(item.value.declaration.id, item.value.input, command.value);
              }
            }
            yield* turn.answer(
              { execution: command.execution, grant: command.grant },
              { ok: true, value: command.value },
            );
            yield* turn.run();
          } else if (command?.type === "continue") {
            yield* conversation.turn(command.root).run();
          }
          const turns: ChatView["turns"] = [];
          for (const turn of conversation.turns()) {
            turns.push(
              yield* readDemoTurn(
                demo,
                turn.execution,
                turn.prompt,
                conversation.reader(turn.execution),
              ),
            );
          }
          const view = {
            thread,
            latest: turns.at(-1)?.execution ?? null,
            turns,
          } satisfies ChatView;
          if (textId) {
            events.send({ type: "TEXT_MESSAGE_END", messageId: textId });
          }
          events.send({ type: "CUSTOM", name: demo.viewEvent, value: view });
          events.send({ type: "RUN_FINISHED", threadId: thread, runId });
          return view;
        } catch (error) {
          events.send({
            type: "RUN_ERROR",
            message:
              "The request did not finish. Check server configuration or retry the same command. Progress may already be saved.",
          });
          throw error;
        }
      });
    },
  };
}
