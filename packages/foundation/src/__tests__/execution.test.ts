import { createQueue, run, spawn, suspend } from "effection";
import { expect, it } from "vitest";
import { createExecution } from "../execution.ts";

it("keeps advancement closed while the owner retries a failed release", async () => {
  let attempts = 0;
  const { execution } = createExecution({
    initial: { kind: "suspended", suspensionId: "question", request: null },
    driver: {
      *resume() {
        throw new Error("closed computation must not advance");
      },
      *cancel() {
        throw Error("Unexpected cancellation");
      },
      *dispose() {
        attempts++;
        if (attempts === 1) {
          throw new Error("release failed");
        }
      },
    },
  });

  await expect(run(() => execution.dispose())).rejects.toThrow("release failed");
  await expect(run(() => execution.resume("question", null))).rejects.toThrow("execution_closed");
  await expect(run(() => execution.cancel())).rejects.toThrow("execution_closed");
  await run(() => execution.dispose());
  await run(() => execution.dispose());
  expect(attempts).toBe(2);
});

it("allows the owner to finish an interrupted release without overlapping disposal", async () => {
  await run(function* () {
    const releasing = createQueue<void, never>();
    let attempts = 0;
    let released = false;
    const { execution } = createExecution({
      initial: { kind: "completed", value: "finished" },
      driver: {
        *resume() {
          throw new Error("terminal computation must not advance");
        },
        *cancel() {
          throw Error("Unexpected cancellation");
        },
        *dispose() {
          attempts++;
          if (attempts === 1) {
            releasing.add();
            yield* suspend();
          }
          released = true;
        },
      },
    });

    const firstRelease = yield* spawn(() => execution.dispose());
    yield* releasing.next();
    let overlap: unknown;
    try {
      yield* execution.dispose();
    } catch (error) {
      overlap = error;
    }
    expect(overlap).toEqual(new Error("execution_command_in_progress"));
    yield* firstRelease.halt();
    expect(released).toBe(false);
    yield* execution.dispose();
    yield* execution.dispose();
    expect(released).toBe(true);
    expect(attempts).toBe(2);
  });
});
