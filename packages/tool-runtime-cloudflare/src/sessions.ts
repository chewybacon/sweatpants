/// <reference types="@cloudflare/workers-types" preserve="true" />
import { DurableObject } from "cloudflare:workers";
import { createScope, run, suspend, withResolvers, type Task } from "effection";
import { isExecutableToolContract, type AnyToolContract } from "@sweatpants/agent-sdk";
import { type Json, canonicalDigest } from "@sweatpants/foundation";
import type { ToolSession, ToolInvocationResume, ToolSessionEvent } from "@sweatpants/tool-session";
import { createToolInvocationExecution } from "@sweatpants/tool-session/invocation-execution";
import type { SessionMetadata, ToolSessionRpc } from "./session-protocol.ts";

export type ToolSessionsClass = new (
  ctx: DurableObjectState,
  env: unknown,
) => DurableObject<unknown> & ToolSessionRpc;

/** One ordinary invocation per DO. A lost generator is never automatically replayed. */
export function createToolSessions(options: {
  tools: readonly AnyToolContract[];
  /** Bounds retained compute; defaults to ten minutes from invocation start. */
  maxLifetimeMs?: number;
}): ToolSessionsClass {
  const lifetime = options.maxLifetimeMs ?? 600_000;
  if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 600_000) {
    throw new Error("maxLifetimeMs must be between 1 and 600000");
  }
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  if (tools.size !== options.tools.length) {
    throw new Error("Duplicate session tool name");
  }
  for (const tool of tools.values()) {
    if (!isExecutableToolContract(tool)) {
      throw new Error(`Session tool is not executable: ${tool.name}`);
    }
  }

  return class ToolSessions extends DurableObject<unknown> implements ToolSessionRpc {
    private session?: ToolSession;
    private stop?: () => Promise<void>;
    private readonly reads = new Map<string, Task<IteratorResult<ToolSessionEvent, void>>>();

    private requireSession(): ToolSession {
      if (!this.session) {
        throw new Error("tool_session_lost: live generator is unavailable; start a new invocation");
      }
      return this.session;
    }

    async start(wire: string): Promise<string> {
      const result = await this.ctx.blockConcurrencyWhile(async () => {
        try {
          return { value: await this.initialize(wire) };
        } catch (error) {
          return { error };
        }
      });
      if ("error" in result) {
        throw result.error;
      }
      return result.value;
    }

    private async initialize(wire: string): Promise<string> {
      const request = JSON.parse(wire) as { invocationId: string; toolName: string; input: Json };
      const digest = canonicalDigest(request);
      const previous = await this.ctx.storage.get<{ digest: string; metadata: SessionMetadata }>(
        "invocation",
      );
      if (previous) {
        if (previous.digest !== digest) {
          throw new Error("invocation_conflict: invocation already started with different input");
        }
        this.requireSession();
        return JSON.stringify(previous.metadata);
      }
      const tool = tools.get(request.toolName);
      if (!tool || !isExecutableToolContract(tool)) {
        throw new Error(`Unknown session tool: ${request.toolName}`);
      }
      const metadata: SessionMetadata = {
        id: request.invocationId,
        toolName: tool.name,
        elicitBindings: tool.bindings.elicits,
      };
      // Persist identity before executing user code. Eviction must never cause duplicate effects.
      await this.ctx.storage.put("invocation", { digest, metadata });
      await this.ctx.storage.setAlarm(Date.now() + lifetime);
      const [scope, destroy] = createScope();
      const ready = withResolvers<ToolSession>("DO session ready");
      const owner = scope.run(function* () {
        try {
          ready.resolve(
            yield* createToolInvocationExecution(tool, request.input, {
              sessionId: request.invocationId,
            }),
          );
          yield* suspend();
        } catch (error) {
          ready.reject(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      });
      this.stop = async () => {
        await owner.halt();
        await run(destroy);
      };
      // Bounded by the storage alarm. No keepalive polling; the DO owns the live invocation.
      this.ctx.waitUntil(Promise.resolve(owner));
      this.session = await run(() => ready.operation);
      return JSON.stringify(metadata);
    }

    async inspect(): Promise<string> {
      const stored = await this.ctx.storage.get<{ metadata: SessionMetadata }>("invocation");
      if (!stored) {
        return "null";
      }
      this.requireSession();
      return JSON.stringify(stored.metadata);
    }

    async next(readerId: string, cursor: number): Promise<string> {
      if (this.reads.has(readerId)) {
        throw new Error("Concurrent session read");
      }
      const session = this.requireSession();
      const task = run(function* () {
        const subscription = yield* session.projection.events(cursor);
        return yield* subscription.next();
      });
      this.reads.set(readerId, task);
      try {
        return JSON.stringify(await task);
      } finally {
        this.reads.delete(readerId);
      }
    }

    async cancelRead(readerId: string): Promise<void> {
      await this.reads.get(readerId)?.halt();
    }

    async resume(wire: string): Promise<void> {
      const session = this.requireSession();
      const response = JSON.parse(wire) as ToolInvocationResume;
      await run(() => session.resume(response));
    }

    async close(): Promise<void> {
      this.session = undefined;
      await Promise.all([...this.reads.values()].map((task) => task.halt()));
      await this.stop?.();
      this.stop = undefined;
      await this.ctx.storage.deleteAlarm();
    }

    override async alarm(): Promise<void> {
      await this.close();
    }
  };
}
