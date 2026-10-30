import type { Operation } from "@standard-durability/core";
import {
  createProgramExecution,
  type Guest,
  type ProgramInvocation,
  type ResolvedProgram,
} from "@sweatpan.ts/execution";

/** Resolver, input, Guest outcomes and snapshot state retain their public types. */
export function programTypes<Y>(
  resolve: (
    invocation: ProgramInvocation<{ topic: string }>,
  ) => Operation<ResolvedProgram<number, string, Y, boolean, string, { offset: number }>, Y>,
) {
  const execution = createProgramExecution({
    invocation: { program: "pinned", input: { topic: "research" } },
    resolve,
    checkpointFormat: "snapshot:v1",
  });
  const acquired: Operation<Guest<number, string, Y, boolean, string>, Y> = execution.acquire();
  if (execution.checkpoints) {
    execution.checkpoints.restore({ offset: 3 });
    // @ts-expect-error Snapshot state stays correlated with the resolved adapter.
    execution.checkpoints.restore({ offset: "wrong" });
  }
  // @ts-expect-error Guest result remains number, not string.
  const wrong: Operation<Guest<string, string, Y, boolean, string>, Y> = acquired;
  return { execution, acquired, wrong };
}

/** Inline resolution infers its result without a ResolvedProgram return annotation. */
export function inlineProgramTypes<Y>(guest: Guest<number, string, Y, boolean, { code: string }>) {
  const execution = createProgramExecution({
    invocation: { program: "inline", input: { topic: "research" } },
    *resolve(invocation) {
      const topic: string = invocation.input.topic;
      return {
        program: invocation.program,
        *acquire() {
          void topic;
          return guest;
        },
      };
    },
  });
  function* consume() {
    const acquired = yield* execution.acquire();
    yield* acquired.resume({ ok: true, value: true });
    yield* acquired.resume({ ok: false, error: { code: "declined" } });
    // @ts-expect-error Successful outcomes retain boolean input.
    yield* acquired.resume({ ok: true, value: "wrong" });
    // @ts-expect-error Error outcomes retain their structured input.
    yield* acquired.resume({ ok: false, error: "wrong" });
    const typed: Guest<number, string, Y, boolean, { code: string }> = acquired;
    return typed;
  }
  return { execution, consume };
}
