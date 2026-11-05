import type { Operation } from "@standard-durability/core";
import type { DatabaseSync } from "node:sqlite";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { Dependencies } from "./program.ts";
import { createConversation } from "./conversation.ts";
import { submission, SubmissionRejected, type View } from "./contracts.ts";

/** Local single-conversation application. Request objects exercise the same route
 * boundary in acceptance and the Node listener. No browser owns execution lifetime. */
export function createApplication<Y>(
  runtime: Runtime<Y>,
  db: DatabaseSync,
  dependencies: Dependencies<Y>,
) {
  const conversation = createConversation(runtime, db, "default", dependencies);
  let closed = false;
  let busy = false;
  const tasks = new Set<ReturnType<typeof runtime.start>>();
  async function execute<T>(work: () => Operation<T, Y>) {
    if (closed) {
      throw new Error("Application closed");
    }
    const task = runtime.start(work);
    tasks.add(task);
    try {
      return await task.result;
    } finally {
      tasks.delete(task);
    }
  }
  async function observe(): Promise<View> {
    return execute(function* () {
      const messages: View["messages"] = [];
      let status: View["status"] = "empty";
      let latest: string | null = null;
      for (const turn of conversation.turns()) {
        latest = turn.execution;
        const state = yield* conversation.read(turn.execution);
        messages.push({
          type: "message",
          id: `${turn.execution}/user`,
          role: "user",
          parts: [{ type: "text", id: `${turn.execution}/prompt`, text: turn.prompt }],
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
            parts: [{ type: "text", id: `${turn.execution}/response`, text }],
          });
        }
      }
      return { messages, latest, status };
    });
  }
  return {
    async fetch(request: Request): Promise<Response> {
      if (closed) {
        return Response.json({ error: "Application closed" }, { status: 503 });
      }
      const url = new URL(request.url);
      if (url.pathname !== "/api/conversation") {
        return new Response("Not found", { status: 404 });
      }
      if (request.method === "GET") {
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
      let input;
      try {
        input = submission.parse(await request.json());
      } catch {
        return Response.json({ error: "Invalid submission" }, { status: 400 });
      }
      if (busy) {
        return Response.json(
          { error: "A turn is already advancing. Refresh before retrying." },
          { status: 409 },
        );
      }
      busy = true;
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
        await execute(() => conversation.turn(receipt.execution).run());
        const state = await execute(() => conversation.read(receipt.execution));
        if (state.status !== "completed") {
          return Response.json(
            { error: "Turn remains unresolved. No automatic retry is safe." },
            { status: 409 },
          );
        }
        return Response.json(receipt);
      } catch {
        return Response.json(
          {
            error:
              "Submission not confirmed. Refresh or retry the same submission; model work may already have been accepted.",
          },
          { status: 409 },
        );
      } finally {
        busy = false;
      }
    },
    async close() {
      closed = true;
      await Promise.all([...tasks].map((task) => task.cancel()));
    },
  };
}
