import { createCloudflareSessionResources } from "./session-client.ts";
import type { ToolSessionNamespace } from "./session-protocol.ts";
export type { ToolSessionNamespace, ToolSessionRpc } from "./session-protocol.ts";
export { createCloudflareSessionResources } from "./session-client.ts";
import { call, resource } from "effection";
import {
  CrankError,
  createDurableToolRegistry,
  exactProgramKey,
  REPLAY_CHECKPOINT_CAPABILITIES,
  replayProgramRecovery,
  type DurableToolRegistry,
  type ProgramAttachment,
  type ProgramDriver,
  type ProgramStep,
} from "@sweatpants/durable-execution";
import { isChatDurableTool, type ToolExecutionAdapter } from "@sweatpants/tool-session/execution";
import type {
  AttachmentMetadata,
  ExecutorResult,
  ToolExecutorEntrypoint,
  ToolExecutorNamespace,
  ToolExecutorRpc,
} from "./protocol.ts";

export type { ToolExecutorEntrypoint, ToolExecutorRpc, ToolExecutorNamespace } from "./protocol.ts";

function unwrap<T>(wire: string): T {
  const result = JSON.parse(wire) as ExecutorResult<T>;
  if (!result.ok) throw new CrankError(result.error.code, result.error.message);
  return result.value;
}

class AttachmentHandle {
  closed = false;
  constructor(readonly rpc: ToolExecutorRpc) {}
  toJSON(): never {
    throw new Error("Cloudflare attachment handles are runtime-only");
  }
}

/** Remote compute only. Authority, effect resolution and replay remain host-owned. */
export function createCloudflareProgramDriver(
  worker: ToolExecutorEntrypoint,
  registry: DurableToolRegistry,
): ProgramDriver {
  function handle(attachment: ProgramAttachment): AttachmentHandle {
    if (!(attachment.handle instanceof AttachmentHandle))
      throw new CrankError("program_protocol_error", "Attachment belongs to another driver");
    return attachment.handle;
  }
  return {
    evaluatorKind: "remote",
    capabilities: REPLAY_CHECKPOINT_CAPABILITIES,
    ...replayProgramRecovery,
    *attach(request) {
      return yield* resource<ProgramAttachment>(function* (provide) {
        // The returned RPC target pins this attachment within the active request.
        const rpc = yield* call(() => worker.createExecutor());
        const owner = new AttachmentHandle(rpc);
        let metadata: AttachmentMetadata | undefined;
        try {
          const response = yield* call(() => rpc.attach(JSON.stringify(request)));
          metadata = unwrap<AttachmentMetadata>(response);
          yield* provide({ ...metadata, handle: owner });
        } finally {
          try {
            if (!owner.closed && metadata) {
              owner.closed = true;
              const attachmentId = metadata.attachmentId;
              const response = yield* call(() => rpc.shutdown(attachmentId, "scope_exit"));
              unwrap(response);
            }
          } finally {
            yield* call(() => Promise.resolve(rpc[Symbol.dispose]()));
          }
        }
      });
    },
    *step(attachment, command) {
      const owner = handle(attachment);
      if (owner.closed) throw new CrankError("stale_program_capability", "Attachment is closed");
      const response = yield* call(() =>
        owner.rpc.step(attachment.attachmentId, JSON.stringify(command)),
      );
      return unwrap<ProgramStep>(response);
    },
    *shutdown(attachment, reason) {
      const owner = handle(attachment);
      if (owner.closed) return;
      const response = yield* call(() => owner.rpc.shutdown(attachment.attachmentId, reason));
      unwrap(response);
      owner.closed = true;
    },
    *manifest(program) {
      const tool = registry.get(exactProgramKey(program));
      if (!tool)
        throw new CrankError("program_version_unavailable", `Program unavailable: ${program.id}`);
      return tool.manifest;
    },
  };
}

/** Request-scoped remote compute; replay recovers the next activation. */
export function cloudflare(options: {
  worker?: ToolExecutorEntrypoint;
  executors?: ToolExecutorNamespace;
  sessions?: ToolSessionNamespace;
}): ToolExecutionAdapter {
  if (options.worker && options.executors)
    throw new Error("Choose either a worker entrypoint or an executors DO binding");
  const entrypoint =
    options.worker ??
    (options.executors
      ? {
          createExecutor: () => options.executors!.getByName(crypto.randomUUID()).createExecutor(),
        }
      : undefined);
  return {
    prepare(tools, routeId) {
      const durable = tools.filter(isChatDurableTool);
      const ordinary = tools.filter((tool) => !isChatDurableTool(tool));
      if (ordinary.length && !options.sessions)
        throw new Error("Cloudflare ordinary tools require a sessions DO binding");
      if (durable.length && !entrypoint)
        throw new Error(
          "Cloudflare durable tools require a worker entrypoint or executors DO binding",
        );
      const driverKind = `cloudflare:${routeId}`;
      return {
        runtimeId: "cloudflare",
        createResources: ordinary.length
          ? function* () {
              return createCloudflareSessionResources(options.sessions!);
            }
          : undefined,
        bindings: durable.map((tool) => ({
          publicName: tool.name,
          tool,
          route: { driverKind },
          activation: "fenced" as const,
        })),
        drivers: durable.length
          ? [
              [
                driverKind,
                createCloudflareProgramDriver(entrypoint!, createDurableToolRegistry(durable)),
              ],
            ]
          : [],
      };
    },
  };
}
