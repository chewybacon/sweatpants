/// <reference types="@cloudflare/workers-types" preserve="true" />
import { WorkerEntrypoint, DurableObject, RpcTarget } from "cloudflare:workers";
import { run, type Operation } from "effection";
import {
  CrankError,
  createDurableToolRegistry,
  type DurableTool,
  type ProgramAttachment,
  type AttachProgramRequest,
  type ProgramCommand,
  type ProgramShutdownReason,
} from "@sweatpants/durable-execution";
import { createWorkflowProgramDriver } from "@sweatpants/journal-authority";
import type { ToolExecutorRpc } from "./protocol.ts";

export type ToolExecutorClass = new (
  ctx: ExecutionContext,
  env: unknown,
) => WorkerEntrypoint<unknown> & { createExecutor(): ExecutorTarget };

/** Loaded evaluator code. Every attachment gets its own request-scoped RPC target. */
export function createToolExecutor(options: {
  tools: readonly DurableTool<any, any>[];
}): ToolExecutorClass {
  const registry = createDurableToolRegistry([...options.tools]);
  return class ToolExecutor extends WorkerEntrypoint<unknown> {
    createExecutor() {
      return new ExecutorTarget(registry, (cleanup) => this.ctx.waitUntil(cleanup));
    }
  };
}

export type ToolExecutorObjectClass = new (
  ctx: DurableObjectState,
  env: unknown,
) => DurableObject<unknown> & { createExecutor(): ExecutorTarget };

/** Disposable replay compute in a DO; durable truth stays in the host journal. */
export function createToolExecutorObject(options: {
  tools: readonly DurableTool<any, any>[];
}): ToolExecutorObjectClass {
  const registry = createDurableToolRegistry([...options.tools]);
  return class ToolExecutorObject extends DurableObject<unknown> {
    createExecutor() {
      return new ExecutorTarget(registry, (cleanup) => this.ctx.waitUntil(cleanup));
    }
  };
}

class ExecutorTarget extends RpcTarget implements ToolExecutorRpc {
  constructor(
    registry: ReturnType<typeof createDurableToolRegistry>,
    private readonly waitUntil: (cleanup: Promise<unknown>) => void,
  ) {
    super();
    this.driver = createWorkflowProgramDriver(registry, { detachedScope: true });
  }
  private readonly driver: ReturnType<typeof createWorkflowProgramDriver>;
  private attachment?: ProgramAttachment;
  private busy = false;
  private used = false;

  private async execute<T>(operation: () => Operation<T>): Promise<string> {
    if (this.busy)
      return JSON.stringify({
        ok: false,
        error: { code: "program_protocol_error", message: "Concurrent executor command" },
      });
    this.busy = true;
    try {
      return JSON.stringify({ ok: true, value: await run(operation) });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error:
          error instanceof CrankError
            ? { code: error.code, message: error.message }
            : { code: "executor_failed", message: "Cloudflare tool executor failed" },
      });
    } finally {
      this.busy = false;
    }
  }

  async attach(wire: string): Promise<string> {
    const self = this;
    return this.execute(function* () {
      if (self.used) throw new CrankError("program_protocol_error", "Executor already used");
      self.used = true;
      const request = JSON.parse(wire) as AttachProgramRequest;
      self.attachment = yield* self.driver.attach(request);
      const { handle: _handle, ...metadata } = self.attachment;
      return metadata;
    });
  }

  async step(attachmentId: string, wire: string) {
    const self = this;
    return this.execute(function* () {
      const attachment = self.attachment;
      if (!attachment || attachment.attachmentId !== attachmentId)
        throw new CrankError(
          "stale_program_capability",
          "Executor attachment is unavailable; restore from the journal",
        );
      const command = JSON.parse(wire) as ProgramCommand;
      return yield* self.driver.step(attachment, command);
    });
  }

  async shutdown(attachmentId: string, reason: string) {
    const self = this;
    return this.execute(function* () {
      const attachment = self.attachment;
      if (!attachment) return;
      if (attachment.attachmentId !== attachmentId)
        throw new CrankError("stale_program_capability", "Executor attachment does not match");
      yield* self.driver.shutdown(attachment, reason as ProgramShutdownReason);
      self.attachment = undefined;
    });
  }
  [Symbol.dispose]() {
    const attachment = this.attachment;
    if (attachment) {
      this.attachment = undefined;
      this.waitUntil(run(() => this.driver.shutdown(attachment, "scope_exit")));
    }
  }
}
