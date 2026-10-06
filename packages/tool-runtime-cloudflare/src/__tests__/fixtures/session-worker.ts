import { z } from "zod";
import { createTool } from "@sweatpants/agent-sdk";
import { createToolSessions } from "../../sessions.ts";
export const twoTurns = createTool("two_turns")
  .description("Two independent user interactions")
  .parameters(z.object({ label: z.string() }))
  .elicits({ choose: { response: z.object({ value: z.string() }) } })
  .execute(function* (params, ctx) {
    const identity = crypto.randomUUID();
    const first = yield* ctx.elicit("choose", { message: "First" });
    const second = yield* ctx.elicit("choose", { message: "Second" });
    return { label: params.label, identity, first: first.action, second: second.action };
  });
export const Sessions = createToolSessions({ tools: [twoTurns] });
export default {
  async fetch(
    request: Request,
    env: { SESSIONS: DurableObjectNamespace<InstanceType<typeof Sessions>> },
  ) {
    const { id, method, args } = (await request.json()) as {
      id: string;
      method: "start" | "inspect" | "next" | "cancelRead" | "resume" | "close";
      args: never[];
    };
    const stub = env.SESSIONS.getByName(id);
    try {
      const value = await (stub[method] as (...args: never[]) => Promise<unknown>)(...args);
      return Response.json({ value });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  },
};
