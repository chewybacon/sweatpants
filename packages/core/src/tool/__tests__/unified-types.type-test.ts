/**
 * Type-level pins for unified tool types (REQ-029).
 * Compile-time only — no runtime assertions.
 */
import { createTool } from "../create.ts";
import type {
  RuntimeTool,
  ElicitDefinition,
  ExtractElicitContext,
  ExtractElicitResponse,
  ToolElicitResult,
  WireElicitResult,
  ToolCtx,
} from "../types.ts";
import { z } from "zod";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// Response-first ElicitDefinition
type Def = ElicitDefinition<z.ZodObject<{ ok: z.ZodBoolean }>>;
type _ctxUndefined = Expect<Equal<ExtractElicitContext<Def>, undefined>>;
type _respOk = Expect<Equal<ExtractElicitResponse<Def>, { ok: boolean }>>;
void 0 as unknown as _ctxUndefined;
void 0 as unknown as _respOk;

// Truthful result arms
type AcceptArm = Extract<ToolElicitResult<{ n: number }, { ok: boolean }>, { action: "accept" }>;
type DeclineArm = Extract<ToolElicitResult<{ n: number }, { ok: boolean }>, { action: "decline" }>;
type _acceptHasExchange = Expect<
  Equal<AcceptArm["exchange"] extends { context: { n: number } } ? true : false, true>
>;
type _declineNoContent = Expect<Equal<"content" extends keyof DeclineArm ? true : false, false>>;
type _declineNoExchange = Expect<Equal<"exchange" extends keyof DeclineArm ? true : false, false>>;
void 0 as unknown as _acceptHasExchange;
void 0 as unknown as _declineNoContent;
void 0 as unknown as _declineNoExchange;

type WireAccept = Extract<WireElicitResult<{ ok: boolean }>, { action: "accept" }>;
type _wireNoExchange = Expect<Equal<"exchange" extends keyof WireAccept ? true : false, false>>;
void 0 as unknown as _wireNoExchange;

// Builder inference + RuntimeTool assignability
const tool = createTool("probe")
  .description("probe")
  .parameters(z.object({ trip: z.string() }))
  .elicits({
    confirm: { response: z.object({ confirmed: z.boolean() }) },
    pick: {
      response: z.object({ id: z.string() }),
      context: z.object({ n: z.number() }),
    },
  })
  .execute(function* (params, ctx) {
    const a = yield* ctx.elicit("confirm", { message: `Confirm ${params.trip}?` });
    if (a.action === "accept") {
      a.content.confirmed.valueOf();
    }
    const b = yield* ctx.elicit("pick", { message: "Pick", context: { n: 1 } });
    if (b.action === "accept") {
      b.content.id.valueOf();
    }
    // @ts-expect-error undeclared key
    yield* ctx.elicit("missing", { message: "nope" });
    // @ts-expect-error context required
    yield* ctx.elicit("pick", { message: "nope" });
    // @ts-expect-error no index signature
    void (ctx as ToolCtx).nonexistentMethod;
    return { ok: true as const };
  });

const _runtime: RuntimeTool = tool;
// ToolDefinition default generics are empty elicits; use RuntimeTool for sinks
void _runtime;
void tool;
// Concrete tools are assignable to the erased wire sink
type _assignableToRuntime = Expect<typeof tool extends RuntimeTool ? true : false>;
void 0 as unknown as _assignableToRuntime;
