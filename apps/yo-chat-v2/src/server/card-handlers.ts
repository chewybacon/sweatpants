import type { DatabaseSync } from "node:sqlite";
import type { Runtime } from "@sweatpan.ts/runtime";
import { z } from "zod";
import { cardId } from "../tools/pick-card.ts";
import { createPickCardSession } from "./pick-card.ts";

const executionId = z.uuid();
const answer = z
  .object({
    grant: z.object({ requestId: z.string().min(1), resolutionId: z.string().min(1) }).strict(),
    card: cardId,
  })
  .strict();
type Context = { request: Request; params: { execution: string } };

/** Local demo HTTP boundary. The opener transfers connection ownership to this request. */
export function createCardHandlers<Y>(runtime: Runtime<Y>, openDatabase: () => DatabaseSync) {
  async function handle({ request, params }: Context, action: "read" | "start" | "answer") {
    const execution = executionId.safeParse(params.execution);
    if (!execution.success) {
      return Response.json({ error: "invalid-execution-id" }, { status: 400 });
    }
    // This local app has no user authentication yet. Do not accept cross-origin writes.
    const origin = request.headers.get("origin");
    if (action !== "read" && origin !== null && origin !== new URL(request.url).origin) {
      return Response.json({ error: "foreign-origin" }, { status: 403 });
    }
    let command: z.infer<typeof answer> | undefined;
    if (action === "answer") {
      try {
        command = answer.parse(await request.json());
      } catch {
        return Response.json({ error: "invalid-answer" }, { status: 400 });
      }
    }
    const db = openDatabase();
    try {
      const session = createPickCardSession(runtime, db, execution.data);
      const value = await runtime.start(() =>
        runtime.withSignal(request.signal, function* () {
          if (action === "read") {
            return yield* session.read();
          }
          if (action === "start") {
            return yield* session.start();
          }
          return yield* session.answer(command!.grant, command!.card);
        }),
      ).result;
      return value === undefined
        ? Response.json({ error: "not-found" }, { status: 404 })
        : Response.json(value, { headers: { "Cache-Control": "no-store" } });
    } finally {
      // runtime.start().result settles only after its scoped resources are joined.
      db.close();
    }
  }
  return {
    GET: (context: Context) => handle(context, "read"),
    POST: (context: Context) => handle(context, "start"),
    PUT: (context: Context) => handle(context, "answer"),
    ANY: () => new Response(null, { status: 405, headers: { Allow: "GET, POST, PUT" } }),
  };
}
