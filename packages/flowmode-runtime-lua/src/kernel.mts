import { record, type LuaState, type LuaInvoker } from "./state.ts";
import { decodeExchange } from "@sweatpants/flowmode-runtime";
import type { Operation } from "effection";
import { assertJson, type Json } from "@sweatpants/foundation";
import {
  assertKernelCompatibility,
  createKernelExecution,
  createWorkflowKernel,
  createWorkflowRuntime,
  type WorkflowBoundary,
  type KernelIdentity,
  type KernelSnapshot,
  type WorkflowKernel,
  type WorkflowProgram,
  type WorkflowRuntime,
  type WorkflowInspection,
} from "@sweatpants/flowmode-runtime";

export const luaIdentity: KernelIdentity = Object.freeze({
  kind: "flowmode-runtime-lua",
  version: "2",
  programFormat: "piccolo-lua-source-2",
  snapshotFormat: "piccolo-continuation-4",
});
export function createLuaRuntime(invoke: LuaInvoker): WorkflowRuntime {
  return createWorkflowRuntime({
    driver: {
      kernelIdentity: luaIdentity,
      *createKernel() {
        return createLuaKernel(invoke);
      },
    },
  });
}

/** Portable Lua kernel. Snapshots must come from trusted kernel persistence. */
export function createLuaKernel(invoke: LuaInvoker): WorkflowKernel {
  let closed = false,
    used = false,
    busy = false,
    poisoned = false;
  let program: WorkflowProgram;
  let state: LuaState;
  let current: WorkflowBoundary;
  let sequence = 0;
  const activation = crypto.randomUUID();
  function idle() {
    if (closed) {
      throw Error("Lua kernel closed");
    }
    if (busy) {
      throw Error("Lua kernel command in progress");
    }
    if (poisoned) {
      throw Error("Lua kernel outcome unknown");
    }
  }
  function decodeBoundary(value: Json | undefined, preserveSuspension = false): WorkflowBoundary {
    const b = record(value);
    switch (b.kind) {
      case "suspended": {
        const request = record(b.request);
        if (typeof request.site !== "string" || !("request" in request)) {
          throw Error("Invalid Lua effect boundary");
        }
        return {
          kind: "suspended",
          suspensionId:
            preserveSuspension && current?.kind === "suspended"
              ? current.suspensionId
              : `${activation}:${++sequence}`,
          request: decodeExchange(request.site, assertJson(request.request)),
        };
      }
      case "completed":
        return { kind: "completed", value: assertJson(b.value) };
      case "failed":
        return { kind: "failed", error: assertJson(b.error) };
      case "cancelled":
        return typeof b.reason === "string"
          ? { kind: "cancelled", reason: b.reason }
          : { kind: "cancelled" };
      default:
        throw Error("Invalid Lua boundary kind");
    }
  }
  function* transition(
    action: string,
    fields: Record<string, Json> = {},
  ): Operation<WorkflowBoundary> {
    idle();
    busy = true;
    let finished = false;
    try {
      const preserve =
        action === "cancel" && (state?.cancelling === true || Number(state?.cleanup_depth) > 0);
      let result = yield* invoke({ source: assertJson(program.code), action, ...fields });
      // This headless adapter automatically continues slices up to a bounded allowance.
      while (record(result.boundary).kind === "compute_paused") {
        if (Number(result.fuel_used) >= 20_000_000) {
          result = {
            ...result,
            vm: null,
            boundary: {
              kind: "failed",
              error: {
                code: "execution_budget_exceeded",
                message: "Workflow reached the maximum computation allowance",
              },
            },
          };
          break;
        }
        result = yield* invoke({
          source: assertJson(program.code),
          action: "continue",
          state: result,
        });
      }
      const next = decodeBoundary(result.boundary, preserve);
      state = result;
      current = next;
      finished = true;
      return next;
    } finally {
      busy = false;
      if (!finished) {
        poisoned = true;
      }
    }
  }
  function prepare(next: WorkflowProgram, snapshot?: KernelSnapshot) {
    idle();
    if (used) {
      throw Error("Lua kernel already used");
    }
    assertKernelCompatibility(luaIdentity, next, snapshot);
    if (typeof next.code !== "string") {
      throw Error("Lua program must contain source");
    }
    program = structuredClone(next);
    used = true;
  }
  const driver = {
    *inspect() {
      idle();
      return inspectLua(state, current);
    },
    *turn(command: Parameters<Parameters<typeof createKernelExecution>[0]["driver"]["turn"]>[0]) {
      if (command.kind === "cancel") {
        return yield* transition("cancel", {
          state,
          reason: command.reason ?? null,
        });
      }
      return yield* transition(command.reply.kind === "throw" ? "reject" : "resume", {
        state,
        reply: command.reply.value,
      });
    },
    *capture(): Operation<KernelSnapshot> {
      idle();
      return {
        kernel: { ...luaIdentity },
        programDigest: program.digest,
        state: structuredClone(state),
      };
    },
    *dispose() {
      if (busy) {
        throw Error("Lua kernel command in progress");
      }
      closed = true;
    },
  };
  return createWorkflowKernel({
    driver: {
      identity: luaIdentity,
      *start(next, input) {
        prepare(next);
        const boundary = yield* transition("start", { input });
        return createKernelExecution({ initial: boundary, driver: driver });
      },
      *restore(next, snapshot) {
        prepare(next, snapshot);
        const saved = record(snapshot.state);
        const boundary = yield* transition("restore", { state: saved });
        return createKernelExecution({ initial: boundary, driver: driver });
      },
      *close() {
        yield* driver.dispose();
      },
    },
  });
}

function inspectLua(state: LuaState, boundary: WorkflowBoundary): WorkflowInspection {
  const vm = state.vm as { frames?: Record<string, Json>[] } | null;
  const frames = (vm?.frames ?? []).map((frame, index) => ({
    index,
    kind: Object.keys(frame)[0],
    detail: JSON.stringify(frame),
  }));
  const calls = Array.isArray(state.calls)
    ? state.calls.map((name, index) => ({ id: String(index), name: String(name) }))
    : [];
  const { suspensionId: _, ...position } = boundary as WorkflowBoundary & { suspensionId?: string };
  return {
    execution: {
      availability: {
        calls: Array.isArray(state.calls) ? "available" : "unavailable",
        environments: "unavailable",
        unwind: "unavailable",
      },
      boundary: position,
      calls,
      environments: [],
      unwind: [],
      truncated: false,
    },
    mode: boundary.kind,
    site: boundary.kind === "suspended" ? boundary.request.site : null,
    steps: null,
    snapshotBytes: new TextEncoder().encode(JSON.stringify(state)).length,
    cancellationRequested: state.cancelling === true,
    currentEnvironment: null,
    calls: calls.map((c) => c.name),
    // oxlint-disable-next-line unicorn/no-array-reverse -- App type libraries target ES2022; reverse a copy.
    frames: frames.slice().reverse(),
    environments: [],
    cleanups: [],
  };
}
