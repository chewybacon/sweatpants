import type { Operation } from "effection";
import {
  ToolInvocationEventSourcePort,
  ToolInvocationHostPort,
  type StartToolInvocation,
  type ToolInvocationResource,
  type ToolInvocationResourceFactory,
  type ToolSession,
} from "@sweatpants/tool-session";
import { createToolInvocationHost } from "@sweatpants/tool-session";
import { createAgentCoreToolInvocationResources } from "./agentcore/agentcore-invocation-resources.ts";
import type { InteractionBinding } from "@sweatpants/agent-sdk";
import type {
  AgentCoreToolRuntimeProfile,
  AgentCoreToolSessionHandle,
  RemoteToolRuntimeClient,
} from "./agentcore/agentcore-types.ts";
import {
  createInMemoryAgentCoreToolSessionEventStore,
  createInMemoryAgentCoreToolSessionHandleStore,
} from "./agentcore/agentcore-memory-store.ts";
import {
  createRedisAgentCoreToolSessionEventStore,
  createRedisAgentCoreToolSessionHandleStore,
  type AgentCoreRedisStoreOptions,
  type RedisLikeClient,
} from "./agentcore/agentcore-redis-store.ts";

export type AgentCoreToolInvocationPersistence =
  | { readonly kind: "memory" }
  | {
      readonly kind: "redis";
      readonly client: RedisLikeClient;
      readonly options?: AgentCoreRedisStoreOptions;
    };

export interface AgentCoreToolInvocationRuntimeOptions {
  readonly runtimeClient: RemoteToolRuntimeClient<AgentCoreToolSessionHandle>;
  readonly profiles: AgentCoreToolRuntimeProfile[];
  readonly defaultProfile?: string;
  readonly now?: () => Date;
  readonly createRuntimeSessionId?: (sessionId: string, toolName: string) => string;
  readonly persistence?: AgentCoreToolInvocationPersistence;
}

function remoteResource(
  session: ToolSession,
  elicitBindings: Readonly<Record<string, InteractionBinding>>,
  dispose: (id: string) => Operation<void>,
): ToolInvocationResource {
  return {
    id: session.id,
    toolName: session.toolName,
    elicitBindings,
    projection: session.projection,
    resume: (resume) => session.resume(resume),
    *dispose() {
      yield* dispose(session.id);
    },
  };
}

export function* createAgentCoreToolInvocationRuntime(
  options: AgentCoreToolInvocationRuntimeOptions,
): Operation<void> {
  const persistence = options.persistence ?? { kind: "memory" };
  const stores =
    persistence.kind === "redis"
      ? {
          handles: createRedisAgentCoreToolSessionHandleStore(
            persistence.client,
            persistence.options,
          ),
          events: createRedisAgentCoreToolSessionEventStore(
            persistence.client,
            persistence.options,
          ),
        }
      : {
          handles: createInMemoryAgentCoreToolSessionHandleStore(),
          events: createInMemoryAgentCoreToolSessionEventStore(),
        };
  const resources = createAgentCoreToolInvocationResources({
    stores,
    runtimeClient: options.runtimeClient,
    profiles: options.profiles,
    ...(options.defaultProfile === undefined ? {} : { defaultProfile: options.defaultProfile }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.createRuntimeSessionId === undefined
      ? {}
      : { createRuntimeSessionId: options.createRuntimeSessionId }),
  });
  const factory: ToolInvocationResourceFactory = {
    *create(request: StartToolInvocation) {
      const session = yield* resources.create(request.tool, request.input, {
        sessionId: request.invocationId,
        ...(request.model === undefined ? {} : { model: request.model }),
      });
      return remoteResource(session, request.tool.bindings.elicits, (id) => resources.dispose(id));
    },
    *open(invocationId) {
      const session = yield* resources.get(invocationId);
      if (!session) {
        return null;
      }
      const bindings = yield* resources.elicitBindings(invocationId);
      if (!bindings) {
        throw new Error(`AgentCore invocation "${invocationId}" omitted authored bindings`);
      }
      return remoteResource(session, bindings, (id) => resources.dispose(id));
    },
  };

  yield* ToolInvocationHostPort.installDriver(createToolInvocationHost(factory));
  yield* ToolInvocationEventSourcePort.installDriver({
    *open(invocationId) {
      const resource = yield* factory.open(invocationId);
      return resource?.projection ?? null;
    },
  });
}
