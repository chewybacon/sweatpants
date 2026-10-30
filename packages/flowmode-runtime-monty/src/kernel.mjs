import { call } from "effection";
import { assertJson, canonicalDigest } from "@sweatpants/foundation";
import {
  assertKernelCompatibility,
  createKernelExecution,
  createWorkflowKernel,
} from "@sweatpants/flowmode-runtime";
import { instantiate } from "../generated/monty.component.js";
import { createWasiImports } from "./wasi.mjs";
import { executableManifestDigest } from "../generated/executable-identity.mjs";
import {
  parseHostRequest,
  validHostReply,
  readFileContract,
  parsePlaygroundRequest,
  validPlaygroundReply,
  playgroundCapabilities,
} from "./contract.mjs";
import { guestLibrary } from "./guest.mjs";

export const montyIdentity = Object.freeze({
  kind: "flowmode-runtime-monty",
  version: canonicalDigest({
    library: guestLibrary,
    executableManifest: executableManifestDigest,
    adapter: "public-async1",
    contract: readFileContract,
  }),
  programFormat: "monty-python-source-1",
  snapshotFormat: "monty-dump35-min13-host1",
});

export const playgroundIdentity = Object.freeze({
  ...montyIdentity,
  version: canonicalDigest({
    base: montyIdentity.version,
    profile: "playground1",
    capabilities: playgroundCapabilities,
  }),
});

/** One disposable actual Wasm instance; only trusted journal snapshots may be loaded. */
export function createMontyKernel(loadModule, options = {}) {
  const playground = options.profile === "playground";
  const identity = playground ? playgroundIdentity : montyIdentity;
  let worker,
    program,
    current,
    closed = false;
  /** @type {{dump:string|null,operations:Array<{id:number,label:string}>,round:number,cancelling:boolean,terminal:import('@sweatpants/flowmode-runtime').WorkflowBoundary|null}} */
  let state = { dump: null, operations: [], round: 0, cancelling: false, terminal: null };
  function dispatch(request) {
    if (closed || !worker) {
      throw Error("Monty kernel unavailable");
    }
    const response = worker.dispatch(request);
    if (response.status !== "continue" || response.events.length !== 1) {
      throw Error("Unexpected Monty worker response");
    }
    const event = response.events[0];
    if (["error", "fatal-error", "typing-error"].includes(event.tag)) {
      throw Error(`Monty: ${JSON.stringify(event.val)}`);
    }
    return event;
  }
  function feed(code, inputs = [], nodes = []) {
    return dispatch({
      tag: "feed",
      val: { code, inputs, values: { nodes }, skipTypeCheck: true, cwd: "" },
    });
  }
  function settleBoundary(event) {
    // Admission acknowledgements register futures; the Rust scheduler owns their ordering.
    let admissions = 0;
    while (event.tag === "function-call") {
      if (++admissions > 256) {
        throw Error("Too many operations in one turn");
      }
      const { callId, functionName, args, kwargs, values } = event.val;
      if (
        !["exchange", "sandbox.exchange"].includes(functionName) ||
        args.length !== 1 ||
        kwargs.length
      ) {
        throw Error("Unsupported Monty host call");
      }
      const payload = decode(values, args[0]);
      const request =
        functionName === "sandbox.exchange"
          ? playground
            ? parsePlaygroundRequest(payload)
            : parseHostRequest(payload)
          : null;
      const label = request
        ? playground
          ? request.capability
          : `Read ${request.arguments.path}`
        : payload;
      if (playground && !request) {
        throw Error("Playground requires a supplied sandbox capability");
      }
      if (typeof label !== "string" || (!request && label.length > 256)) {
        throw Error("Invalid operation label");
      }
      state.operations.push(request ? { id: callId, label, request } : { id: callId, label });
      event = dispatch({
        tag: "resume-call",
        val: { callId, outcome: { tag: "pending-future", val: callId }, values: { nodes: [] } },
      });
    }
    if (event.tag === "resolve-futures") {
      const pending = new Set(event.val.pendingCallIds);
      state.operations = state.operations.filter((op) => pending.has(op.id));
      if (!state.operations.length || state.operations.length !== pending.size) {
        throw Error("No routable host operations");
      }
      current = {
        kind: "suspended",
        suspensionId: crypto.randomUUID(),
        request: {
          site: `monty:${state.round}`,
          binding: "monty.operations",
          input: { operations: structuredClone(state.operations) },
        },
      };
    } else if (event.tag === "complete") {
      const value = decode(event.val.values, event.val.value);
      if (state.cancelling) {
        if (value?.status !== "cancelled") {
          throw Error("Monty cancellation envelope missing");
        }
        current = { kind: "cancelled", reason: value.reason };
      } else {
        current = { kind: "completed", value: assertJson(value) };
      }
      state.operations = [];
      state.terminal = current;
      state.dump = null;
    } else {
      throw Error(`Unsupported Monty boundary: ${event.tag}`);
    }
    return current;
  }
  function* prepare(next, snapshot) {
    if (worker || closed) {
      throw Error("Monty kernel already used");
    }
    assertKernelCompatibility(identity, next, snapshot);
    if (typeof next.code !== "string") {
      throw Error("Expected Python source");
    }
    program = next;
    const component = yield* call(() => instantiate(loadModule, createWasiImports()));
    worker = component.worker;
    if (worker.cancellationContract() !== 7) {
      throw Error("Unsupported Monty cancellation contract");
    }
    dispatch({
      tag: "configure",
      val: {
        scriptName: "workflow.py",
        limits: {
          maxTurnDurationMicros: 2000000n,
          maxFeedDurationMicros: 10000000n,
          maxMemoryBytes: 67108864n,
          maxRecursionDepth: 200n,
          maxSuspensions: 1000n,
        },
        typeCheck: false,
        typeCheckFormat: "full",
        typeCheckColor: false,
      },
    });
  }
  const driver = {
    validateReply(_request, reply) {
      const value = reply.value?.action === "accept" ? reply.value.content : reply.value;
      if (
        reply.kind !== "value" ||
        !(playground ? validPlaygroundReply(value) : validHostReply(value)) ||
        !state.operations.some((op) => op.id === value.operationId)
      ) {
        throw Error("Reply must select a currently outstanding operation");
      }
      if (playground && !value.error) {
        encodeValue(value.value);
      }
    },
    *turn(command) {
      if (command.kind === "cancel" && state.cancelling) {
        return current;
      }
      state.round++;
      state.dump = null;
      let val;
      if (command.kind === "cancel") {
        state.cancelling = true;
        val = {
          nativeCancel: command.reason ?? "Cancelled by host",
          results: [],
          values: { nodes: [] },
        };
      } else {
        const { operationId, value, error } =
          command.reply.value?.action === "accept"
            ? command.reply.value.content
            : command.reply.value;
        val = {
          results: [
            {
              callId: operationId,
              outcome: error
                ? { tag: "error", val: { excType: error.type, message: error.message } }
                : {
                    tag: "return-value",
                    val: playground ? encodeValue(value).nodes.length - 1 : 0,
                  },
            },
          ],
          values: error
            ? { nodes: [] }
            : playground
              ? encodeValue(value)
              : { nodes: [{ tag: "text", val: value }] },
        };
      }
      return settleBoundary(dispatch({ tag: "resume-futures", val }));
    },
    *capture() {
      if (closed) {
        throw Error("Monty kernel closed");
      }
      // Retain producer bytes until a turn changes state: Monty dumps are opaque,
      // and equivalent reserialization need not preserve map ordering.
      if (!state.terminal && !state.dump) {
        const event = dispatch({ tag: "dump" });
        if (event.tag !== "dump-result") {
          throw Error("Expected Monty dump");
        }
        state.dump = encodeBytes(event.val);
      }
      return {
        kernel: identity,
        programDigest: program.digest,
        state: structuredClone(state),
      };
    },
    *inspect() {
      yield* driver.capture();
      const { suspensionId: _id, ...boundary } = current;
      return {
        execution: {
          availability: {
            calls: "unavailable",
            environments: "unavailable",
            unwind: "unavailable",
          },
          boundary,
          calls: [],
          environments: [],
          unwind: [],
          truncated: false,
        },
        mode: current.kind,
        site: current.kind === "suspended" ? current.request.site : null,
        steps: null,
        snapshotBytes: state.dump ? atob(state.dump).length : 0,
        cancellationRequested: state.cancelling,
        currentEnvironment: null,
        calls: [],
        frames: [],
        environments: [],
        cleanups: [],
      };
    },
    *dispose() {
      if (!closed && worker) {
        dispatch({ tag: "reset" });
      }
      worker = undefined;
      closed = true;
    },
  };
  return createWorkflowKernel({
    driver: {
      identity,
      *start(next) {
        yield* prepare(next);
        if (typeof next.code !== "string") {
          throw Error("Expected Python source");
        }
        if (feed(guestLibrary).tag !== "complete") {
          throw Error("Guest library failed");
        }
        const definitions = feed(
          next.code,
          [{ name: "exchange", value: 0 }],
          [{ tag: "function", val: { name: "exchange" } }],
        );
        if (definitions.tag !== "complete") {
          throw Error("Define async main(); top-level host effects are unsupported");
        }
        const boundary = settleBoundary(feed("import asyncio\nasyncio.run(main())"));
        return createKernelExecution({ initial: boundary, driver });
      },
      *restore(next, snapshot) {
        yield* prepare(next, snapshot);
        state = structuredClone(snapshot.state);
        const boundary =
          state.terminal ??
          settleBoundary(
            dispatch({
              tag: "load",
              val: Uint8Array.from(atob(state.dump), (c) => c.charCodeAt(0)),
            }),
          );
        current = boundary;
        return createKernelExecution({ initial: boundary, driver });
      },
      *close() {
        yield* driver.dispose();
      },
    },
  });
}
function encodeBytes(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(text);
}
function decode(values, index) {
  const node = values.nodes[index];
  switch (node?.tag) {
    case "none":
      return null;
    case "text":
    case "boolean":
    case "float":
      return node.val;
    case "integer": {
      const value = Number(node.val);
      if (!Number.isSafeInteger(value)) {
        throw Error("Integer exceeds JSON safe range");
      }
      return value;
    }
    case "list-value":
    case "tuple-value":
      return Array.from(node.val, (id) => decode(values, id));
    case "dict":
      return Object.fromEntries(
        node.val.map((pair) => [decode(values, pair.key), decode(values, pair.value)]),
      );
    default:
      throw Error(`Unsupported guest result: ${node?.tag}`);
  }
}

function encodeValue(value) {
  assertJson(value);
  const nodes = [];
  function visit(item, depth = 0) {
    if (depth > 64 || nodes.length > 16000) {
      throw Error("Host result exceeds value budget");
    }
    let node;
    if (item === null) {
      node = { tag: "none" };
    } else if (typeof item === "string") {
      node = { tag: "text", val: item };
    } else if (typeof item === "boolean") {
      node = { tag: "boolean", val: item };
    } else if (typeof item === "number") {
      node = Number.isSafeInteger(item)
        ? { tag: "integer", val: BigInt(item) }
        : { tag: "float", val: item };
    } else if (Array.isArray(item)) {
      node = { tag: "list-value", val: item.map((x) => visit(x, depth + 1)) };
    } else {
      node = {
        tag: "dict",
        val: Object.entries(item).map(([key, val]) => ({
          key: visit(key, depth + 1),
          value: visit(val, depth + 1),
        })),
      };
    }
    nodes.push(node);
    return nodes.length - 1;
  }
  visit(value);
  return { nodes };
}
