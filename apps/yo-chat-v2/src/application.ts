import type { Operation } from "@standard-durability/core";
import type { DatabaseSync } from "node:sqlite";
import { createReadableStream, type Runtime, type Stream } from "@sweatpan.ts/runtime";
import type { TextSampling } from "./sampling.ts";
import { createConversation } from "./conversation.ts";
import { answerSchema, submission, SubmissionRejected, type View } from "./contracts.ts";

import { codeResult } from "./code-contracts.ts";
import { flightResult } from "./flight.ts";

/** Local single-conversation application. Request objects exercise the same route
 * boundary in acceptance and the Node listener. No browser owns execution lifetime. */
export function createApplication<Y>(
  runtime: Runtime<Y>,
  db: DatabaseSync,
  dependencies: {
    readonly sampling: TextSampling<Y>;
    readonly loadLuaModule?: () => Promise<WebAssembly.Module>;
  },
) {
  let closed = false;
  let admitting = false;
  let active: string | undefined;
  const watchers = new Set<() => void>();
  const changed = () => {
    for (const wake of watchers) {
      wake();
    }
  };
  const conversation = createConversation(
    runtime,
    db,
    "default",
    dependencies.sampling,
    changed,
    dependencies.loadLuaModule,
  );
  const tasks = new Set<ReturnType<typeof runtime.start>>();
  const ownedRuntime: Runtime<Y> = {
    ...runtime,
    start(work) {
      if (closed) {
        throw new Error("Application closed");
      }
      const task = runtime.start(work);
      tasks.add(task);
      void task.result.then(
        () => tasks.delete(task),
        () => tasks.delete(task),
      );
      return task;
    },
  };
  function execute<T>(work: () => Operation<T, Y>) {
    return ownedRuntime.start(work).result;
  }
  async function advance(execution: string) {
    if (active !== undefined) {
      return;
    }
    const state = await execute(() => conversation.read(execution));
    if (state.status === "completed" || state.status === "cancelled") {
      return;
    }
    if (closed) {
      throw new Error("Application closed");
    }
    active = execution;
    void execute(() => conversation.turn(execution).run())
      .catch(() => {
        /* Unknown delivery stays occupied; no automatic retry grant. */
      })
      .finally(() => {
        if (active === execution) {
          active = undefined;
        }
        changed();
      });
  }
  // Only coalesced wakeups are buffered per reader. The retained projection is
  // the truth; every new connection starts with an invalidation, never a cursor
  // that assumes the browser still has an earlier projection.
  function changes() {
    const stream: Stream<Uint8Array, void, Y> = {
      *[Symbol.iterator]() {
        const signal = runtime.createSignal<void>();
        const subscription = yield* signal;
        let notified = false;
        const wake = () => {
          if (!notified) {
            notified = true;
            signal.send();
          }
        };
        yield* runtime.composition.ensure(function* () {
          watchers.delete(wake);
        });
        watchers.add(wake);
        wake();
        return {
          *next() {
            yield* subscription.next();
            notified = false;
            return {
              done: false as const,
              value: new TextEncoder().encode('{"type":"changed"}\n'),
            };
          },
        };
      },
    };
    return new Response(createReadableStream(ownedRuntime, stream), {
      headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
    });
  }
  async function observe(): Promise<View> {
    return execute(function* () {
      const messages: View["messages"] = [];
      const questions: View["questions"] = [];
      let status: View["status"] = "empty";
      let latest: string | null = null;
      for (const turn of conversation.turns()) {
        latest = turn.execution;
        const state = yield* conversation.read(turn.execution);
        const pending = yield* conversation.questions(turn.execution);
        const codeRuns = yield* conversation.codeRuns(turn.execution);
        questions.push(...pending);
        messages.push({
          type: "message",
          id: `${turn.execution}/user`,
          role: "user",
          parts: [
            { type: "text", id: `${turn.execution}/prompt`, text: turn.prompt, state: "complete" },
          ],
        });
        status =
          state.status === "completed"
            ? "completed"
            : state.status === "cancelled"
              ? "cancelled"
              : "running";
        if (state.status === "completed") {
          const text = state.value.response.message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
          messages.push({
            type: "message",
            id: `${turn.execution}/assistant`,
            role: "assistant",
            parts: [{ type: "text", id: `${turn.execution}/response`, text, state: "complete" }],
          });
        } else {
          const text = conversation.preview(turn.execution);
          if (text !== undefined) {
            messages.push({
              type: "message",
              id: `${turn.execution}/assistant`,
              role: "assistant",
              parts: [
                { type: "text", id: `${turn.execution}/response`, text, state: "provisional" },
              ],
            });
          }
        }
        let assistant = messages.find((message) => message.id === `${turn.execution}/assistant`);
        if ((pending.length || codeRuns.length) && !assistant) {
          assistant = {
            type: "message",
            id: `${turn.execution}/assistant`,
            role: "assistant",
            parts: [],
          };
          messages.push(assistant);
        }
        for (const run of codeRuns) {
          assistant!.parts.push({
            type: "code-run",
            id: run.id,
            run,
            questions: pending.filter((question) => question.parentExecution === run.id),
          });
        }
        for (const question of pending) {
          if (codeRuns.some((run) => run.id === question.parentExecution)) {
            continue;
          }
          assistant!.parts.push({
            type: "question",
            id: JSON.stringify([question.execution, question.grant]),
            question,
          });
        }
        if (state.status === "completed" && assistant) {
          for (const [index, message] of state.value.history
            .slice(
              state.value.history.reduce(
                (last, message, index) => (message.role === "user" ? index : last),
                -1,
              ) + 1,
            )
            .entries()) {
            if (message.role !== "tool" || typeof message.content !== "string") {
              continue;
            }
            let value: unknown;
            try {
              value = JSON.parse(message.content);
            } catch {
              continue;
            }
            const code = codeResult.safeParse(value);
            const selected = flightResult.safeParse(
              code.success && code.data.status === "completed" ? code.data.value : value,
            );
            if (selected.success) {
              assistant.parts.push({
                type: "flight-selection",
                id: `${turn.execution}/flight/${index}`,
                selection: selected.data,
              });
            }
          }
        }
      }
      return { messages, questions, latest, status, active: active !== undefined };
    });
  }
  return {
    async fetch(request: Request): Promise<Response> {
      if (closed) {
        return Response.json({ error: "Application closed" }, { status: 503 });
      }
      const url = new URL(request.url);
      if (url.pathname === "/api/conversation/changes" && request.method === "GET") {
        return changes();
      }
      if (url.pathname !== "/api/conversation" && url.pathname !== "/api/conversation/answers") {
        return new Response("Not found", { status: 404 });
      }
      if (request.method === "GET" && url.pathname === "/api/conversation") {
        return Response.json(await observe(), { headers: { "Cache-Control": "no-store" } });
      }
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (request.headers.get("origin") && request.headers.get("origin") !== url.origin) {
        return new Response("Origin rejected", { status: 403 });
      }
      if (!request.headers.get("content-type")?.startsWith("application/json")) {
        return new Response("JSON required", { status: 415 });
      }
      if (url.pathname === "/api/conversation/answers") {
        const parsed = answerSchema.safeParse(await request.json().catch(() => undefined));
        if (!parsed.success) {
          return Response.json({ error: "Invalid answer" }, { status: 400 });
        }
        if (admitting || active !== undefined) {
          return Response.json(
            { error: "Conversation is advancing; retry the same answer" },
            { status: 409 },
          );
        }
        admitting = true;
        try {
          const receipt = await execute(() => conversation.answer(parsed.data));
          await advance(parsed.data.root);
          changed();
          return Response.json(receipt);
        } catch {
          return Response.json(
            { error: "Answer not confirmed. Refresh before retrying the identical answer." },
            { status: 409 },
          );
        } finally {
          admitting = false;
        }
      }
      let input;
      try {
        input = submission.parse(await request.json());
      } catch {
        return Response.json({ error: "Invalid submission" }, { status: 400 });
      }
      if (admitting) {
        return Response.json(
          { error: "A turn is already advancing. Refresh before retrying." },
          { status: 409 },
        );
      }
      admitting = true;
      try {
        let receipt;
        try {
          receipt = await execute(() => conversation.submit(input));
        } catch (error) {
          if (error instanceof SubmissionRejected) {
            return Response.json(
              { kind: "not-admitted", command: input.command, code: error.code },
              { status: 409 },
            );
          }
          throw error;
        }
        await advance(receipt.execution);
        changed();
        return Response.json(receipt, { status: 202 });
      } catch {
        return Response.json(
          {
            error:
              "Submission not confirmed. Refresh or retry the same submission; model work may already have been accepted.",
          },
          { status: 409 },
        );
      } finally {
        admitting = false;
      }
    },
    async close() {
      closed = true;
      await Promise.all([...tasks].map((task) => task.cancel()));
    },
  };
}
