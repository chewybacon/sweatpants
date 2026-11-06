import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Operation } from "@standard-durability/core";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { createRecovery, type OwnedChild } from "@sweatpan.ts/durable";
import { createScopedGuest, type Guest, type Turn } from "@sweatpan.ts/execution";
import { createKernel, createCodeAuthoring, createCodeValidator } from "@sweatpan.ts/codemode";
import {
  createLuaKernel,
  createLuaValidator,
  defineLuaEffectBindings,
  luaWasmUrl,
  luaLibraryWasmUrl,
  LuaFailure,
} from "@sweatpan.ts/codemode-runtime-lua";
import {
  createEffectCapabilities,
  createHosting,
  installGuestRetention,
  childHostingResult,
} from "@sweatpan.ts/hosting";
import { installToolRouting } from "@sweatpan.ts/tools";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { ChatToolBinding } from "@sweatpan.ts/chat-host";
import { chooseFlight } from "./flight.ts";
import {
  codeInput,
  codeToolId as currentCodeToolId,
  legacyCodeToolId,
  type CodeResult,
} from "./code-contracts.ts";

const modules = new Map<string, Promise<WebAssembly.Module>>();
function loadModule(legacy: boolean) {
  const url = legacy ? luaWasmUrl : luaLibraryWasmUrl;
  let compiled = modules.get(url.href);
  if (!compiled) {
    compiled = readFile(url).then((bytes) => WebAssembly.compile(bytes));
    modules.set(url.href, compiled);
  }
  return compiled;
}
const bindings = defineLuaEffectBindings({ choose_flight: chooseFlight });
const prelude = `local function choose_flight(request)
  local outcome = workflow.effect("choose_flight", { effect = "choose_flight", input = request })
  assert(outcome.ok, "Flight selection failed")
  return outcome.value
end\n`;

/** Application assembly: the root pins selected bindings; child admission pins source/input.
 * Only the selected flight tool is granted. No evaluator-owned external effects or retry loop. */
export function createCodeBinding<Y>(
  runtime: Runtime<Y>,
  flight?: ChatToolBinding<Y>,
  loader?: () => Promise<WebAssembly.Module>,
  legacy = false,
): ChatToolBinding<Y> & { describe(): Operation<string, Y> } {
  const codeToolId = legacy ? legacyCodeToolId : currentCodeToolId;
  const loadLuaModule = loader ?? (() => loadModule(legacy));
  const rejectedRequest = defineEffect({
    key: `${codeToolId}/rejected-request`,
    context: z.string(),
    response: z.never(),
  });
  const libraryGuide = legacy
    ? "Standard library: assert, type, pcall, error; no IO, require, math, string, table, print or network."
    : "Standard library: assert, type, pcall, error, string.sub(text, first, last), string.char(byte, ...), table.concat(values, separator). Only those string/table functions are available. table.concat accepts at most 10000 values with a conservative 1MiB output budget. No IO, require, math, print or network. Return arrays directly or join them with table.concat.";
  const authoring = createCodeAuthoring(runtime, "lua-authoring", {
    *describe({ bindings: catalog }) {
      return {
        language: "lua",
        instructions: `Run a bounded Lua program and return one JSON-compatible value. Use source, optional JSON input (available as input), and optional validateOnly. Syntax errors return diagnostics: repair them in a new call. validateOnly checks syntax without executing. ${libraryGuide} Use workflow.null for JSON null. Variables, tables, loops and arithmetic are supported. Call only the listed capabilities; do not redefine them or call workflow.effect directly. Accepted tool actions are not undone on a later error, so do not blindly repeat a failed program. ${JSON.stringify(catalog)}`,
      };
    },
  });
  const validation = createCodeValidator(
    runtime,
    "lua-validation",
    createLuaValidator(runtime, loadLuaModule),
  );
  const kernel = createKernel(
    runtime.composition,
    "lua-kernel",
    createLuaKernel(runtime, {
      loadModule: loadLuaModule,
      decodeRequest(value) {
        try {
          const request = bindings.decodeRequest(value);
          if (!flight) {
            throw new Error("No flight handler is available");
          }
          // Reject malformed authored arguments before admission, without schema transforms.
          const parsed = chooseFlight.context.safeParse(request.input);
          if (!parsed.success) {
            throw new Error("Invalid choose_flight request");
          }
          return request;
        } catch (error) {
          return { effect: rejectedRequest.id, input: String(error) };
        }
      },
      decodeResult(value): CodeResult {
        return { status: "completed", value: z.json().parse(value) };
      },
    }),
  );
  return {
    program: codeToolId,
    context: codeInput,
    contract: { id: codeToolId, elicits: {} },
    elicits: {},
    definition: {
      name: "run_lua",
      description:
        "Execute Lua with interactive demo-flight capabilities. Return the selected flight and seat to the user. No real booking or payment.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", minLength: 1, maxLength: 48000 },
          input: {},
          validateOnly: { type: "boolean" },
        },
        required: ["source"],
        additionalProperties: false,
      },
    },
    run(child) {
      return runtime.composition.scoped(function* () {
        if (child.link.program !== codeToolId || child.link.childId !== child.journal.id) {
          throw new Error("Code child does not match binding");
        }
        const admitted = codeInput.parse(child.link.input);
        const source = `local input = ...\n${flight ? prelude : ""}${admitted.source}`;
        const bound = child as OwnedChild<
          CodeResult,
          CapabilityRequest,
          unknown,
          string,
          unknown,
          Y
        >;
        const effects = createEffectCapabilities(runtime, `code-effects:${child.journal.id}`);
        const grant = effects.grant(
          flight ? { choose_flight: chooseFlight, rejectedRequest } : { rejectedRequest },
        );
        const recovery = createRecovery(runtime.composition, {
          name: `code-recovery:${child.journal.id}`,
          program: codeToolId,
          matches: isDeepStrictEqual,
          *acquire(): Operation<Guest<CodeResult, CapabilityRequest, Y>, Y> {
            const checked = yield* validation.operations.validate({
              language: "lua",
              text: source,
            });
            if (!checked.valid || admitted.validateOnly) {
              return createScopedGuest(function* () {
                return checked.valid
                  ? { status: "valid" as const, checked: [...checked.checked] }
                  : {
                      status: "invalid" as const,
                      diagnostics: checked.diagnostics.map((item) => item.message),
                    };
              });
            }
            const recipe = yield* kernel.operations.prepare(source, admitted.input ?? null);
            const guest = yield* recipe.acquire();
            // Only known authored failures become results; infrastructure failures stay unresolved.
            function* advance(
              work: () => Operation<Turn<CodeResult, CapabilityRequest>, Y>,
            ): Operation<Turn<CodeResult, CapabilityRequest>, Y> {
              try {
                return yield* work();
              } catch (error) {
                if (!(error instanceof LuaFailure)) {
                  throw error;
                }
                return {
                  kind: "completed",
                  value: {
                    status: "failed",
                    message: JSON.stringify(error.value),
                  },
                };
              }
            }
            return {
              ...guest,
              start: () => advance(() => guest.start()),
              resume: (outcome) => advance(() => guest.resume(outcome)),
            };
          },
        });
        const host = createHosting(runtime.composition, {
          name: `code-host:${child.journal.id}`,
          journal: bound.journal,
          recovery: recovery.operations,
          attempts: bound.journal.attempts,
          interactions: bound.journal.interactions,
          handle: grant.handle,
        });
        yield* installGuestRetention(runtime.composition, host, recovery, bound.journal);
        yield* host.around(grant.admission);
        yield* effects.install(rejectedRequest, function* (message) {
          return { ok: false, error: message };
        });
        if (flight) {
          yield* installToolRouting(runtime, host, bound.journal, {
            tool: chooseFlight,
            run: (nested) => flight.run(nested),
          });
        }
        return childHostingResult(yield* host.operations.run());
      });
    },
    *describe() {
      const guide = yield* authoring.operations.describe({
        bindings: flight
          ? [
              {
                name: "choose_flight",
                description: flight.definition.description ?? "",
                contract: `${JSON.stringify(flight.definition.parameters)} -> {demo:true,destination,flight:{id,airline,departure,arrival},seat}. Example: return choose_flight({destination="LAX"})`,
              },
            ]
          : [],
      });
      return guide.instructions;
    },
  };
}
