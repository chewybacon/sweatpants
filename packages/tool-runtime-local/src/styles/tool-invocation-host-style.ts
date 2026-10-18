/**
 * Style experiment: the seam the original PoC actually needed.
 *
 * Address lookup is the least interesting property here. The seam is a *host
 * for addressable, resumable tool invocations*: a
 * generator (often in a worker thread) runs under a long-lived scope, parks
 * when it needs a sample or elicit, and a later request attaches to the same
 * invocation to answer it.
 *
 * The degenerate invocation below stands in for a worker: a generator that
 * suspends on a queue until a response arrives. That is the property under
 * test — the execution outlives the scope that started it.
 *
 * Two shapes are compared:
 *
 *   Style H (handle)  — the current shape. The host hands out a session object;
 *                       lifecycle calls go through the port, but turn/respond/
 *                       cancel are invoked on the handle and bypass middleware.
 *   Style F (facade)  — every operation, including turn/respond/cancel, is a
 *                       port member keyed by invocation id.
 */

import {
  createQueue,
  createScope,
  type Operation,
  type Queue,
  type Scope,
  useScope,
} from "effection";
import { definePort } from "@sweatpants/foundation/port";

// =============================================================================
// DEGENERATE INVOCATION: a generator that parks for external input
// =============================================================================

export type ParkKind = "sample" | "elicit";

/** What the host observes when it turns an invocation. */
export type Disposition =
  | { readonly type: "parked"; readonly kind: ParkKind; readonly requestId: string }
  | { readonly type: "completed"; readonly output: string }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "cancelled" };

export type InvocationStatus = "running" | "parked" | "completed" | "failed" | "cancelled";

/** The context a tool body uses to ask for input, mirroring ctx.sample/ctx.elicit. */
export interface InvocationContext {
  ask(kind: ParkKind, prompt: string): Operation<string>;
}

export type ToolBody = (input: string, context: InvocationContext) => Operation<string>;

interface PendingRequest {
  readonly kind: ParkKind;
  readonly requestId: string;
  readonly responses: Queue<string, void>;
}

interface Invocation {
  readonly id: string;
  status: InvocationStatus;
  pending: PendingRequest | undefined;
  /** Resolved once the body settles; the host awaits this to observe terminal state. */
  readonly dispositions: Queue<Disposition, void>;
  cancel(): void;
}

/**
 * Starts the body in `ownerScope`, not the caller's scope. This is the whole
 * point: the request that starts an invocation may exit while it is parked.
 */
function startInvocation(ownerScope: Scope, id: string, body: ToolBody, input: string): Invocation {
  const dispositions = createQueue<Disposition, void>();
  let requestCounter = 0;
  let cancelled = false;

  const invocation: Invocation = {
    id,
    status: "running",
    pending: undefined,
    dispositions,
    cancel() {
      cancelled = true;
      // Unblock a parked body so it can unwind, exactly as closing the worker
      // response channels does in production.
      invocation.pending?.responses.close(undefined);
    },
  };

  const context: InvocationContext = {
    *ask(kind, _prompt) {
      const responses = createQueue<string, void>();
      const requestId = `${id}:req:${++requestCounter}`;
      invocation.pending = { kind, requestId, responses };
      invocation.status = "parked";
      dispositions.add({ type: "parked", kind, requestId });

      const next = yield* responses.next();
      invocation.pending = undefined;
      if (next.done) {
        throw new Error("invocation cancelled while parked");
      }
      invocation.status = "running";
      return next.value;
    },
  };

  void ownerScope
    .run(function* () {
      try {
        const output = yield* body(input, context);
        invocation.status = "completed";
        dispositions.add({ type: "completed", output });
      } catch (error) {
        if (cancelled) {
          invocation.status = "cancelled";
          dispositions.add({ type: "cancelled" });
        } else {
          invocation.status = "failed";
          dispositions.add({
            type: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        dispositions.close();
      }
    })
    .catch(() => undefined);

  return invocation;
}

export class InvocationNotFound extends Error {
  readonly code = "invocation_not_found";
  constructor(readonly invocationId: string) {
    super(`Invocation "${invocationId}" is not available`);
    this.name = "InvocationNotFound";
  }
}

export class InvocationHostUnavailable extends Error {
  readonly code = "invocation_host_unavailable";
  constructor() {
    super("No tool invocation host is installed in this scope");
    this.name = "InvocationHostUnavailable";
  }
}

// =============================================================================
// STYLE H: host hands out a handle
// =============================================================================

/** The handle a caller receives; its methods do not pass through port middleware. */
export interface InvocationHandle {
  readonly id: string;
  status(): Operation<InvocationStatus>;
  turn(): Operation<Disposition>;
  respond(requestId: string, value: string): Operation<void>;
  cancel(): Operation<void>;
}

export interface HandleHost {
  start(id: string, body: ToolBody, input: string): Operation<InvocationHandle>;
  attach(id: string): Operation<InvocationHandle>;
  release(id: string): Operation<void>;
}

export const HandleHostPort = definePort<HandleHost>("style-h-invocation-host", {
  *start(): Operation<InvocationHandle> {
    throw new InvocationHostUnavailable();
  },
  *attach(): Operation<InvocationHandle> {
    throw new InvocationHostUnavailable();
  },
  *release(): Operation<void> {
    throw new InvocationHostUnavailable();
  },
});

export function* createHandleHost(): Operation<HandleHost> {
  const ownerScope = yield* useScope();
  const invocations = new Map<string, Invocation>();
  const refCounts = new Map<string, number>();

  function handleFor(invocation: Invocation): InvocationHandle {
    return {
      id: invocation.id,
      *status() {
        return invocation.status;
      },
      *turn() {
        const next = yield* invocation.dispositions.next();
        return next.done ? { type: "cancelled" } : next.value;
      },
      *respond(requestId, value) {
        const pending = invocation.pending;
        if (!pending || pending.requestId !== requestId) {
          throw new Error(`Invocation "${invocation.id}" is not awaiting ${requestId}`);
        }
        pending.responses.add(value);
      },
      *cancel() {
        invocation.cancel();
      },
    };
  }

  return {
    *start(id, body, input) {
      const invocation = startInvocation(ownerScope, id, body, input);
      invocations.set(id, invocation);
      refCounts.set(id, 1);
      return handleFor(invocation);
    },
    *attach(id) {
      const invocation = invocations.get(id);
      if (!invocation) {
        throw new InvocationNotFound(id);
      }
      refCounts.set(id, (refCounts.get(id) ?? 0) + 1);
      return handleFor(invocation);
    },
    *release(id) {
      const remaining = (refCounts.get(id) ?? 0) - 1;
      refCounts.set(id, remaining);
      if (remaining > 0) {
        return;
      }
      const invocation = invocations.get(id);
      if (invocation && invocation.status !== "running" && invocation.status !== "parked") {
        invocations.delete(id);
        refCounts.delete(id);
      }
    },
  };
}

// =============================================================================
// STYLE F: every operation is a port member keyed by invocation id
// =============================================================================

export interface InvocationHost {
  start(id: string, body: ToolBody, input: string): Operation<void>;
  status(id: string): Operation<InvocationStatus>;
  turn(id: string): Operation<Disposition>;
  respond(id: string, requestId: string, value: string): Operation<void>;
  cancel(id: string): Operation<void>;
  release(id: string): Operation<void>;
}

export const InvocationHostPort = definePort<InvocationHost>("style-f-invocation-host", {
  *start(): Operation<void> {
    throw new InvocationHostUnavailable();
  },
  *status(): Operation<InvocationStatus> {
    throw new InvocationHostUnavailable();
  },
  *turn(): Operation<Disposition> {
    throw new InvocationHostUnavailable();
  },
  *respond(): Operation<void> {
    throw new InvocationHostUnavailable();
  },
  *cancel(): Operation<void> {
    throw new InvocationHostUnavailable();
  },
  *release(): Operation<void> {
    throw new InvocationHostUnavailable();
  },
});

export function* createInvocationHost(): Operation<InvocationHost> {
  const ownerScope = yield* useScope();
  const invocations = new Map<string, Invocation>();
  const refCounts = new Map<string, number>();

  function lookup(id: string): Invocation {
    const invocation = invocations.get(id);
    if (!invocation) {
      throw new InvocationNotFound(id);
    }
    return invocation;
  }

  return {
    *start(id, body, input) {
      invocations.set(id, startInvocation(ownerScope, id, body, input));
      refCounts.set(id, 1);
    },
    *status(id) {
      return lookup(id).status;
    },
    *turn(id) {
      const next = yield* lookup(id).dispositions.next();
      return next.done ? { type: "cancelled" } : next.value;
    },
    *respond(id, requestId, value) {
      const invocation = lookup(id);
      const pending = invocation.pending;
      if (!pending || pending.requestId !== requestId) {
        throw new Error(`Invocation "${id}" is not awaiting ${requestId}`);
      }
      pending.responses.add(value);
    },
    *cancel(id) {
      lookup(id).cancel();
    },
    *release(id) {
      const remaining = (refCounts.get(id) ?? 0) - 1;
      refCounts.set(id, remaining);
      if (remaining > 0) {
        return;
      }
      const invocation = invocations.get(id);
      if (invocation && invocation.status !== "running" && invocation.status !== "parked") {
        invocations.delete(id);
        refCounts.delete(id);
      }
    },
  };
}

/**
 * A host scope that outlives request scopes, mirroring the registry/application
 * scope that owns worker sessions in production.
 */
export function createHostScope(): [Scope, () => Promise<void>] {
  return createScope();
}
