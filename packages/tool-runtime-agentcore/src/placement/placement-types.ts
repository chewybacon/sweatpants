import type { PinnedProgram, SandboxAffinity } from "@sweatpants/durable-execution";

/**
 * AgentCore placement declarations.
 *
 * These describe where AWS AgentCore put a task's compute. They are vendor
 * specific and deliberately live with the runtime that produces them: the
 * journal authority is placement-neutral and must not carry provider concepts
 * in its durable state.
 */

/** Immutable AgentCore release metadata retained for exact task replay. */
export interface AgentCoreRuntimeRelease {
  readonly releaseId: string;
  readonly runtimeArn: string;
  readonly region: string;
  readonly imageDigest: string;
  readonly protocolVersion: 1;
  readonly registryDigest: string;
  readonly iamProfile: string;
  readonly networkProfile: string;
  readonly filesystem: {
    readonly kind: "managed_session_storage";
    readonly mountPath: string;
  };
  readonly lifecycle: {
    readonly idleRuntimeSessionTimeoutSeconds: number;
    readonly maxLifetimeSeconds: number;
  };
}

/** Private task placement. None of these fields belong in semantic descriptors. */
export interface AgentCoreTaskPlacement {
  readonly journalId: string;
  readonly taskId: string;
  readonly affinity: SandboxAffinity;
  readonly runtimeSessionId: string;
  readonly release: AgentCoreRuntimeRelease;
  readonly program: PinnedProgram;
  readonly createdAt: string;
  readonly terminalAt?: string;
  readonly lastComputeGeneration?: string;
}
