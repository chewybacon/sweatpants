import type { DatabaseSync } from "node:sqlite";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createAgUiViewRun, type AgUiRunEvent } from "@sweatpan.ts/protocols-ag-ui";
import type { ChatSampling } from "@sweatpan.ts/chat";
import { type ChatCommand, type ChatView } from "../chat/contract.ts";
import { createDemoConversation } from "./chat-conversation.ts";
import type { ChatDemo } from "./chat-demo.ts";
import { readDemoTurn } from "./chat-view.ts";

export type ChatRunEvent = AgUiRunEvent<ChatView>;

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
  return createAgUiViewRun<ChatView, Y>(runtime, {
    threadId: thread,
    viewEvent: demo.viewEvent,
    errorMessage:
      "The request did not finish. Check server configuration or retry the same command. Progress may already be saved.",
    pendingQuestions(view) {
      return view.turns.flatMap((turn) =>
        turn.parts.flatMap((part) =>
          part.type === "tool"
            ? part.questions.filter(
                (question) => question.state === "open" && question.grant !== undefined,
              )
            : [],
        ),
      );
    },
    *execute(text) {
      const provider: ChatSampling<Y> = command
        ? yield* runtime.fromPromise(() => sampling(text))
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
      return view;
    },
  });
}
