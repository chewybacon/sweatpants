import { run } from "effection";
import { describe, expect, it } from "vitest";
import {
  ToolRuntimeError,
  createStrategyToolRuntime,
  createToolExecutionRef,
  createToolInventory,
  type ToolInventoryEntry,
} from "./index.ts";

const entry: ToolInventoryEntry = {
  definition: {
    name: "echo",
    description: "Echo input",
    parameters: { type: "object" },
  },
};

const call = {
  id: "call-1",
  type: "function" as const,
  function: { name: "echo", arguments: { message: "hello" } },
};

describe("neutral tool runtime contracts", () => {
  it("owns deterministic inventory identity and duplicate rejection", async () => {
    const inventory = createToolInventory([entry]);
    expect(
      await run(function* () {
        return yield* inventory.list();
      }),
    ).toEqual([entry]);
    expect(
      await run(function* () {
        return yield* inventory.resolve("echo");
      }),
    ).toBe(entry);
    expect(() => createToolInventory([entry, entry])).toThrow(
      "Duplicate tool name in inventory: echo",
    );
  });

  it("routes execution through the owning strategy", async () => {
    const runtime = createStrategyToolRuntime({
      id: "runtime-1",
      strategies: [
        {
          id: "echo-strategy",
          toolNames: ["echo"],
          canExecute(candidate) {
            return candidate.definition.name === "echo";
          },
          *execute(_candidate, candidateCall, context) {
            return {
              kind: "completed" as const,
              ref: createToolExecutionRef({
                runtimeId: context.runtimeId,
                callId: candidateCall.id,
                toolName: candidateCall.function.name,
              }),
              result: candidateCall.function.arguments,
            };
          },
        },
      ],
    });

    expect(
      await run(function* () {
        return yield* runtime.execute({ entry, call });
      }),
    ).toMatchObject({
      kind: "completed",
      ref: { runtimeId: "runtime-1", callId: "call-1", toolName: "echo" },
      result: { message: "hello" },
    });
  });

  it("rejects overlapping strategy ownership", () => {
    const strategy = {
      id: "one",
      toolNames: ["echo"],
      canExecute: () => true,
      *execute() {
        throw new Error("unused");
      },
    };
    expect(() =>
      createStrategyToolRuntime({
        strategies: [strategy, { ...strategy, id: "two" }],
      }),
    ).toThrowError(ToolRuntimeError);
  });
});
