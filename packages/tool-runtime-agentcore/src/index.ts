export type {
  AgentCoreRuntimeRelease,
  AgentCoreTaskPlacement,
} from "./placement/placement-types.ts";
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
  RemoteToolRuntimeClient,
  AgentCoreToolRuntimeProfile,
} from "./agentcore/agentcore-types.ts";

export { AGENTCORE_TOOL_SESSION_PROTOCOL_VERSION } from "./agentcore/agentcore-types.ts";

export {
  createAgentCoreToolInvocationRuntime,
  type AgentCoreToolInvocationPersistence,
  type AgentCoreToolInvocationRuntimeOptions,
} from "./invocation-runtime.ts";

export type {
  RedisLikeClient,
  AgentCoreRedisStoreOptions,
} from "./agentcore/agentcore-redis-store.ts";

export {
  createAgentCoreRemoteToolRuntimeClient,
  streamFromAgentCoreResponses,
  protocolErrorStream,
  type AgentCoreInvoker,
  type AgentCoreInvokeInput,
} from "./agentcore/agentcore-runtime-client.ts";

export {
  createAwsSdkAgentCoreInvoker,
  parseAgentCoreSseResponses,
  streamFromAgentCoreToolRuntimeResponses,
  type AwsSdkAgentCoreInvokerOptions,
} from "./agentcore/agentcore-aws-invoker.ts";

export { FakeAgentCoreRemoteToolRuntimeClient } from "./agentcore/agentcore-fake-runtime.ts";

export { exactProgramKey } from "@sweatpants/durable-execution";

export {
  createAgentCoreDurableProgramDriver,
  type AgentCoreDurableProgramTransport,
} from "./durable/durable-driver.ts";

export {
  AGENTCORE_DURABLE_PROTOCOL_VERSION,
  DEFAULT_AGENTCORE_IDLE_TIMEOUT_SECONDS,
  DEFAULT_AGENTCORE_MAX_LIFETIME_SECONDS,
  DEFAULT_AGENTCORE_WORKSPACE_MOUNT,
  agentCoreRuntimeReleaseParser,
  agentCoreTaskPlacementParser,
  createInvocationAgentCorePlacement,
  reconcileAgentCoreDurableReadiness,
  sandboxAffinityParser,
  parseAgentCoreRuntimeRelease,
  parseAgentCoreTaskPlacement,
  verifyAgentCoreRuntimeRelease,
  parseSandboxAffinity,
  type AgentCoreDurableReadiness,
  type AgentCoreDurableReadinessInput,
  type AgentCoreSamplingReadinessInput,
  type InvocationPlacementRequest,
} from "./durable/durable-placement.ts";

export {
  AGENTCORE_MAX_ERROR_TEXT_BYTES,
  AGENTCORE_MAX_FRAME_BYTES,
  computeFrontierDigest,
  computeReplayChainSeed,
  encodeAgentCoreProgramMessage,
  hostProgramMessageParser,
  linkReplayEntry,
  parseHostProgramMessage,
  parseRuntimeProgramMessage,
  runtimeProgramMessageParser,
  verifyReplayEntry,
  type AgentCoreDurableProgramErrorCode,
  type AgentCoreProgramEnvelope,
  type FrontierDigestInput,
  type HostProgramMessage,
  type ReplayChainSeedInput,
  type RuntimeProgramMessage,
} from "./durable/durable-protocol.ts";

export {
  createSigV4AgentCoreWebSocketConnector,
  type AgentCoreWebSocketConnectRequest,
  type AgentCoreWebSocketConnection,
  type AgentCoreWebSocketConnector,
  type SigV4AgentCoreWebSocketConnectorOptions,
} from "./durable/durable-websocket-connector.ts";

export {
  createAgentCoreWebSocketProgramTransport,
  type AgentCoreDurableProgramRoute,
} from "./durable/durable-websocket-transport.ts";

export {
  createAgentCoreDurableEvaluator,
  type AgentCoreDurableEvaluatorOptions,
} from "./durable/durable-evaluator.ts";

export {
  runPlacementModelSampleProducer,
  type PlacementModelProvider,
} from "./placement/placement-model-producer.ts";

export {
  REMOTE_SAMPLE_MAX_RECORD_BYTES,
  createRedisPlacementModelSampler,
  remoteSampleRecordParser,
  type RedisPlacementModelSampler,
} from "./placement/redis-placement-model-sampler.ts";

export {
  createPlacementSamplingAuthorizationIssuer,
  verifyPlacementSamplingAuthorization,
  type PlacementSamplingAuthorizationClaims,
} from "./placement/placement-sampling-authorization.ts";

export {
  createInMemoryPlacementModelSampler,
  type InMemoryPlacementModelSampler,
} from "./placement/in-memory-placement-model-sampler.ts";

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
} from "./placement/placement-model-sampler.ts";

export {
  createAgentCoreActivationCoordinator,
  type AgentCoreActivationCoordinatorOptions,
  type CoordinatedActivationResult,
} from "./durable/durable-activation-coordinator.ts";
