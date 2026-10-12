import { call } from "effection";
import { assertJson } from "@sweatpants/foundation";
import { CrankError } from "@sweatpants/durable-execution";
import type { QuickJSContext, QuickJSWASMModule } from "quickjs-emscripten-core";
import { EVALUATION_LIMITS, type EvaluationStep, type TisynEvaluationDriver } from "./port.ts";
import kernelBundle from "./generated/kernel-source.json" with { type: "json" };

export const QUICKJS_LIMITS = Object.freeze({
  interruptChecks: 256,
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 64 * 1024,
  toolCalls: EVALUATION_LIMITS.toolCalls,
});

/** Interruptible compute only. Sweatpants owns tool dispatch, parking, and replay.
 * The counter works even where Date.now() does not advance during synchronous work.
 */
export function createQuickJSEvaluationDriver(
  load: () => Promise<QuickJSWASMModule>,
): TisynEvaluationDriver {
  const sessions = new Map<string, QuickJSContext>();
  function close(handle: string) {
    const vm = sessions.get(handle);
    if (vm) {
      sessions.delete(handle);
      vm.dispose(); // newContext() owns and disposes its runtime, too.
    }
  }
  function execute(vm: QuickJSContext, code: string, input: unknown): string {
    let checks = 0;
    vm.runtime.setInterruptHandler(() => ++checks > QUICKJS_LIMITS.interruptChecks);
    try {
      const encoded = vm.newString(input === undefined ? "" : JSON.stringify(input));
      try {
        vm.setProp(vm.global, "__input", encoded);
      } finally {
        encoded.dispose();
      }
      const result = vm.evalCode(code);
      vm.runtime.removeInterruptHandler();
      if (result.error) {
        let error: { message?: string };
        try {
          error = vm.dump(result.error) as { message?: string };
        } finally {
          result.error.dispose();
        }
        throw new CrankError(
          "tisyn_evaluation_failed",
          checks > QUICKJS_LIMITS.interruptChecks
            ? `Tisyn evaluation exceeded ${QUICKJS_LIMITS.interruptChecks} compute interrupts between tool calls`
            : `Tisyn evaluation failed: ${error.message ?? "VM failure"}`,
        );
      }
      try {
        return vm.getString(result.value);
      } finally {
        result.value.dispose();
      }
    } finally {
      vm.runtime.removeInterruptHandler();
    }
  }
  return {
    *open(ir) {
      const module = yield* call(load);
      const vm = module.newContext();
      vm.runtime.setMemoryLimit(QUICKJS_LIMITS.memoryBytes);
      vm.runtime.setMaxStackSize(QUICKJS_LIMITS.stackBytes);
      const handle = crypto.randomUUID();
      sessions.set(handle, vm);
      try {
        execute(
          vm,
          `${kernelBundle.kernelSource}\nTisynKernel.open(JSON.parse(__input)); "opened"`,
          ir,
        );
        return handle;
      } catch (error) {
        close(handle);
        throw error;
      }
    },
    *advance(handle, input) {
      const vm = sessions.get(handle);
      if (!vm) {
        throw new Error("Unknown or closed Tisyn evaluation handle");
      }
      try {
        const json = execute(
          vm,
          'TisynKernel.advance(__input === "" ? undefined : JSON.parse(__input))',
          input,
        );
        const step = JSON.parse(json) as EvaluationStep;
        if (step.done) {
          const value = assertJson(step.value);
          close(handle);
          return { done: true, value };
        }
        return { done: false, value: { id: step.value.id, data: assertJson(step.value.data) } };
      } catch (error) {
        close(handle);
        throw error;
      }
    },
    *close(handle) {
      close(handle);
    },
  };
}
