export type { AgentCoreRuntimeRelease, AgentCoreTaskPlacement } from "./placement-types.ts";
export {
  createAgentCoreToolExecutionStrategy,
  createAgentCoreToolRuntimeDriver,
  installAgentCoreToolRuntime,
  type AgentCoreToolExecutionStrategyOptions,
  type AgentCoreToolRuntimeDriverOptions,
} from "./driver.ts";

/** Serializable AgentCore transport, session, event, and store contracts. */
export type {
  AgentCoreModelSelection,
  AgentCoreToolSessionHandle,
  AgentCoreToolSessionStatus,
  AgentCoreToolSessionTerminalStatus,
  AgentCoreToolEvent,
  StoredToolSessionEvent,
  AgentCoreToolRuntimeRequest,
  AgentCoreToolRuntimeResponse,
  StartToolSessionRequest,
  RespondToElicitRequest,
  RespondToSampleRequest,
  CancelToolSessionRequest,
  InspectToolSessionRequest,
  DrainToolSessionEventsRequest,
  RuntimeInvokeOptions,
  SerializableToolSessionHandleStore,
  ToolSessionEventStore,
  RemoteToolRuntimeClient,
  AgentCoreToolRuntimeProfile,
  AgentCoreToolSessionStores,
} from "./agentcore-types.ts";

export { AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION } from "./agentcore-types.ts";

export {
  createAgentCoreToolSession,
  statusFromAgentCoreToolEvent,
} from "./agentcore-tool-session.ts";

export {
  createAgentCoreToolSessionRegistry,
  type AgentCoreToolSessionRegistryOptions,
} from "./agentcore-session-registry.ts";

export {
  setupAgentCoreToolSessions,
  type SetupAgentCoreToolSessionsOptions,
} from "./agentcore-setup.ts";

export {
  createInMemoryAgentCoreToolSessionHandleStore,
  createInMemoryAgentCoreToolSessionEventStore,
} from "./agentcore-memory-store.ts";

export {
  createRedisAgentCoreToolSessionHandleStore,
  createRedisAgentCoreToolSessionEventStore,
  type RedisLikeClient,
  type AgentCoreRedisStoreOptions,
} from "./agentcore-redis-store.ts";

export {
  createAgentCoreRemoteToolRuntimeClient,
  streamFromAgentCoreResponses,
  protocolErrorStream,
  type AgentCoreInvoker,
  type AgentCoreInvokeInput,
} from "./agentcore-runtime-client.ts";

export {
  createAwsSdkAgentCoreInvoker,
  parseAgentCoreSseResponses,
  streamFromAgentCoreToolRuntimeResponses,
  type AwsSdkAgentCoreInvokerOptions,
} from "./agentcore-aws-invoker.ts";

export { FakeAgentCoreRemoteToolRuntimeClient } from "./agentcore-fake-runtime.ts";

export { exactProgramKey } from "@sweatpants/durable-execution";

export {
  createAgentCoreDurableProgramDriver,
  type AgentCoreDurableProgramTransport,
} from "./durable-driver.ts";

export {
  AGENTCORE_DURABLE_PROTOCOL_VERSION,
  DEFAULT_AGENTCORE_IDLE_TIMEOUT_SECONDS,
  DEFAULT_AGENTCORE_MAX_LIFETIME_SECONDS,
  DEFAULT_AGENTCORE_WORKSPACE_MOUNT,
  createInvocationAgentCorePlacement,
  reconcileAgentCoreDurableReadiness,
  parseAgentCoreRuntimeRelease,
  parseAgentCoreTaskPlacement,
  verifyAgentCoreRuntimeRelease,
  parseSandboxAffinity,
  type AgentCoreDurableReadiness,
  type AgentCoreDurableReadinessInput,
  type AgentCoreSamplingReadinessInput,
  type InvocationPlacementRequest,
} from "./durable-placement.ts";

export {
  AGENTCORE_MAX_ERROR_TEXT_BYTES,
  AGENTCORE_MAX_FRAME_BYTES,
  computeFrontierDigest,
  computeReplayChainSeed,
  encodeAgentCoreProgramMessage,
  linkReplayEntry,
  parseHostProgramMessage,
  parseRuntimeProgramMessage,
  verifyReplayEntry,
  type AgentCoreDurableProgramErrorCode,
  type AgentCoreProgramEnvelope,
  type FrontierDigestInput,
  type HostProgramMessage,
  type ReplayChainSeedInput,
  type RuntimeProgramMessage,
} from "./durable-protocol.ts";

export {
  createSigV4AgentCoreWebSocketConnector,
  type AgentCoreWebSocketConnectRequest,
  type AgentCoreWebSocketConnection,
  type AgentCoreWebSocketConnector,
  type SigV4AgentCoreWebSocketConnectorOptions,
} from "./durable-websocket-connector.ts";

export {
  createAgentCoreWebSocketProgramTransport,
  type AgentCoreDurableProgramRoute,
} from "./durable-websocket-transport.ts";

export {
  createAgentCoreDurableEvaluator,
  type AgentCoreDurableEvaluatorOptions,
} from "./durable-evaluator.ts";

export {
  runPlacementModelSampleProducer,
  type PlacementModelProvider,
} from "./placement-model-producer.ts";

export {
  createRedisPlacementModelSampler,
  type RedisPlacementModelSampler,
} from "./redis-placement-model-sampler.ts";

export {
  createPlacementSamplingAuthorizationIssuer,
  verifyPlacementSamplingAuthorization,
  type PlacementSamplingAuthorizationClaims,
} from "./placement-sampling-authorization.ts";

export {
  createInMemoryPlacementModelSampler,
  type InMemoryPlacementModelSampler,
} from "./in-memory-placement-model-sampler.ts";

export {
  AGENTCORE_MODEL_SAMPLING_PROTOCOL_VERSION,
  createPlacementModelSamplingService,
  type PlacementModelSampler,
  type PlacementModelSampleProducerStore,
  type PlacementModelSamplingService,
  type PlacementSamplingAuthorizationIssuer,
  type RemoteModelDeliveryEvent,
  type RemoteProducerFence,
  type RemoteSampleAttachment,
  type RemoteSampleIdentity,
  type RemoteSampleRecord,
  type RemoteSampleState,
} from "./placement-model-sampler.ts";

export {
  createAgentCoreActivationCoordinator,
  type AgentCoreActivationCoordinatorOptions,
  type CoordinatedActivationResult,
} from "./durable-activation-coordinator.ts";
