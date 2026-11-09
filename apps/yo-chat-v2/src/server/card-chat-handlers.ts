import type { DatabaseSync } from "node:sqlite";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { ChatSampling } from "@sweatpan.ts/chat";
import { chatCommand, selectionInput, type ChatView } from "../card-chat/contract.ts";
import { createCardConversation } from "./card-conversation.ts";
import { readCardTurn } from "./card-chat-view.ts";

/** Request-owned work. SSE follows AG-UI event names; CUSTOM carries this app's
 * detached view. Disconnect interrupts local work, not the durable conversation. */
export function createCardChatHandlers<Y>(
  runtime: Runtime<Y>,
  openDatabase: () => DatabaseSync,
  sampling: (publish: (text: string) => void) => Promise<ChatSampling<Y>>,
) {
  async function handle({ request, params }: { request: Request; params: { thread: string } }) {
    const thread = params.thread;
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(thread)) {
      return Response.json({ error: "Invalid thread" }, { status: 400 });
    }
    if (
      request.method !== "GET" &&
      request.headers.has("origin") &&
      request.headers.get("origin") !== new URL(request.url).origin
    ) {
      return new Response(null, { status: 403 });
    }
    const parsed =
      request.method === "GET"
        ? undefined
        : chatCommand.safeParse(await request.json().catch(() => null));
    if (parsed && !parsed.success) {
      return Response.json({ error: "Invalid command" }, { status: 400 });
    }
    const command = parsed?.data;
    const encoder = new TextEncoder();
    let task: ReturnType<typeof runtime.start> | undefined;
    let disposed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        function emit(value: unknown) {
          if (!disposed) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
          }
        }
        const runId = crypto.randomUUID();
        let textId: string | undefined;
        let lastText = "";
        try {
          // Reads do not require credentials. Mutation resolves provider policy first.
          const provider = command
            ? await sampling((text) => {
                if (!textId || !text.startsWith(lastText)) {
                  if (textId) {
                    emit({ type: "TEXT_MESSAGE_END", messageId: textId });
                  }
                  textId = crypto.randomUUID();
                  lastText = "";
                  emit({ type: "TEXT_MESSAGE_START", messageId: textId, role: "assistant" });
                }
                const delta = text.slice(lastText.length);
                lastText = text;
                if (delta) {
                  emit({ type: "TEXT_MESSAGE_CONTENT", messageId: textId, delta });
                }
              })
            : {
                *sample() {
                  throw new Error("Read cannot sample");
                },
              };
          emit({ type: "RUN_STARTED", threadId: thread, runId });
          const current = runtime.start(() =>
            runtime.withSignal(request.signal, function* () {
              const db = openDatabase();
              yield* runtime.composition.ensure(function* () {
                db.close();
              });
              const conversation = createCardConversation(runtime, db, thread, provider);
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
                    const offered = selectionInput.parse(item.value.input).cards;
                    if (
                      !offered.some(
                        (card) =>
                          card.rank === command.value.rank &&
                          card.suit === command.value.suit &&
                          card.display === command.value.display,
                      )
                    ) {
                      throw new Error("Selected card was not offered");
                    }
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
                  yield* readCardTurn(
                    turn.execution,
                    turn.prompt,
                    conversation.reader(turn.execution),
                  ),
                );
              }
              return { thread, latest: turns.at(-1)?.execution ?? null, turns } satisfies ChatView;
            }),
          );
          task = current;
          if (disposed) {
            await current.cancel();
          }
          const view = await current.result;
          if (textId) {
            emit({ type: "TEXT_MESSAGE_END", messageId: textId });
          }
          emit({ type: "CUSTOM", name: "card-chat-view", value: view });
          emit({ type: "RUN_FINISHED", threadId: thread, runId });
        } catch {
          emit({
            type: "RUN_ERROR",
            message:
              "The request did not finish. Check server configuration or retry the same command. Progress may already be saved.",
          });
        } finally {
          if (!disposed) {
            controller.close();
          }
        }
      },
      async cancel() {
        disposed = true;
        await task?.cancel();
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });
  }
  return {
    GET: handle,
    POST: handle,
    ANY: () => new Response(null, { status: 405, headers: { Allow: "GET, POST" } }),
  };
}
