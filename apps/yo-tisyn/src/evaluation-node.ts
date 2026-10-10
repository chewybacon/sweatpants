import { randomUUID } from "node:crypto";
import { createContext, Script, type Context } from "node:vm";
import { evaluate, EMPTY_ENV } from "@tisyn/kernel";
import { assertJson } from "@sweatpants/foundation";
import { EVALUATION_LIMITS, type TisynEvaluationDriver } from "./evaluation.ts";

// Only this fixed host expression runs in the VM. Authored source stays Tisyn IR.
// The VM interrupts synchronous kernel work; it is NOT a security or memory sandbox.
const advance = new Script("kernel.next(input)");

export function createNodeEvaluationDriver(): TisynEvaluationDriver {
  const sessions = new Map<string, Context>();
  return {
    *open(ir) {
      const handle = randomUUID();
      sessions.set(handle, createContext({ kernel: evaluate(ir, EMPTY_ENV), input: undefined }));
      return handle;
    },
    *advance(handle, input) {
      const scope = sessions.get(handle);
      if (!scope) {
        throw new Error("Unknown or closed Tisyn evaluation handle");
      }
      scope.input = input;
      try {
        const result = advance.runInContext(scope, {
          timeout: EVALUATION_LIMITS.stepMilliseconds,
        }) as ReturnType<ReturnType<typeof evaluate>["next"]>;
        if (result.done) {
          sessions.delete(handle);
          return { done: true, value: assertJson(result.value) };
        }
        return {
          done: false,
          value: { id: result.value.id, data: assertJson(result.value.data) },
        };
      } catch (error) {
        sessions.delete(handle);
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
        ) {
          throw new Error(
            `Tisyn evaluation exceeded ${EVALUATION_LIMITS.stepMilliseconds} ms between tool calls`,
            { cause: error },
          );
        }
        throw error;
      }
    },
    *close(handle) {
      // The kernel owns no external resources. Drop the context and generator together.
      sessions.delete(handle);
    },
  };
}
