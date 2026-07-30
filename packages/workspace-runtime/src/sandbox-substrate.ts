import { CrankError } from "@sweatpants/durable-execution";
import { canonicalJson, canonicalSnapshot, sha256, sha256Bytes } from "@sweatpants/foundation";
import { type Json } from "@sweatpants/foundation";
import type { Operation } from "effection";
import { z } from "zod";

type Sha256 = string;

export type WorkspacePersistence =
  | "none"
  | "sandbox_lease"
  | "provider_durable"
  | "checkpoint_restore";

export interface SandboxCapabilities {
  readonly requestResponse: true;
  readonly websocket: boolean;
  readonly warmAttachments: boolean;
  readonly memorySuspend: boolean;
  readonly localDisk: boolean;
  readonly workspacePersistence: WorkspacePersistence;
  readonly checkpointRestore: boolean;
  readonly shell: boolean;
  readonly processExecution: boolean;
  readonly ports: boolean;
  readonly networkPolicy: boolean;
}

const sandboxCapabilitiesSchema = z.strictObject({
  requestResponse: z.literal(true),
  websocket: z.boolean(),
  warmAttachments: z.boolean(),
  memorySuspend: z.boolean(),
  localDisk: z.boolean(),
  workspacePersistence: z.enum(["none", "sandbox_lease", "provider_durable", "checkpoint_restore"]),
  checkpointRestore: z.boolean(),
  shell: z.boolean(),
  processExecution: z.boolean(),
  ports: z.boolean(),
  networkPolicy: z.boolean(),
});

export type SandboxLifecycleState =
  | "creating"
  | "running"
  | "suspending"
  | "suspended"
  | "terminating"
  | "terminated"
  | "gone"
  | "failed";
export type WorkspacePresence = "present" | "empty" | "unknown" | "gone";

export interface SandboxInspection {
  readonly logicalSandboxId: string;
  readonly providerSandboxId: string;
  readonly generation: string;
  readonly state: SandboxLifecycleState;
  readonly workspace: WorkspacePresence;
  readonly capabilities: SandboxCapabilities;
  readonly expiresAt?: string;
}

export interface SandboxDefinition {
  readonly id: string;
  readonly version: string;
  readonly policyDigest: Sha256;
}

export interface SandboxInstanceKeyInput {
  readonly tenant: string;
  readonly rootTaskId: string;
  readonly sandboxDefinition: SandboxDefinition;
  readonly provider: string;
  readonly workspaceHash: Sha256;
  readonly evaluatorAbi: string;
  readonly releaseDigest: Sha256;
}

export interface SandboxActivationFence {
  readonly taskId: string;
  readonly sandboxGeneration: string;
  readonly activationEpoch: number;
}

export interface CreateSandboxRequest {
  readonly logicalSandboxId: string;
  readonly rootTaskId: string;
  readonly definition: SandboxDefinition;
}

export interface RestoreSandboxRequest extends CreateSandboxRequest {
  readonly workspaceVersion: WorkspaceVersion;
}

export interface SandboxConnector {
  request(message: Json): Operation<Json>;
}

export interface SandboxProvider {
  create(request: CreateSandboxRequest): Operation<SandboxInspection>;
  inspect(logicalSandboxId: string): Operation<SandboxInspection | null>;
  connect(inspection: SandboxInspection): Operation<SandboxConnector>;
  suspend?(inspection: SandboxInspection): Operation<void>;
  resume?(inspection: SandboxInspection): Operation<SandboxInspection>;
  restore?(request: RestoreSandboxRequest): Operation<SandboxInspection>;
  terminate(inspection: SandboxInspection): Operation<void>;
}

export type SandboxRecoveryDecision =
  | { readonly kind: "reuse"; readonly inspection: SandboxInspection }
  | { readonly kind: "resume"; readonly inspection: SandboxInspection }
  | { readonly kind: "restore"; readonly workspaceVersion: WorkspaceVersion }
  | { readonly kind: "bootstrap" };

export interface ImmutableObjectRef {
  readonly provider: string;
  readonly namespace: string;
  readonly key: string;
  readonly version?: string;
  readonly digest: Sha256;
  readonly bytes: number;
}

export interface WorkspaceMaterializationRef {
  readonly format: "sweatpants.workspace-materialization.v1";
  readonly kind: "full" | "delta";
  readonly object: ImmutableObjectRef;
  readonly baseVersionDigest?: Sha256;
  readonly taskId: string;
  readonly sandboxGeneration: string;
  readonly createdAt: string;
}

export interface WorkspaceVersion {
  readonly format: "sweatpants.workspace-version.v1";
  readonly workspaceId: string;
  readonly versionDigest: Sha256;
  readonly parentDigest?: Sha256;
  readonly materialization: WorkspaceMaterializationRef;
}

/**
 * Content-addressed storage for workspace materializations.
 *
 * Effection-native (REQ-024) so a remote driver — S3, R2, a microVM host — is
 * cancellable and composable rather than an unstructured promise at the edge.
 * `ImmutableObjectRef` is serialisable identity, so it is the reference that
 * crosses a process boundary, never a store handle (DR-061).
 */
export interface ImmutableObjectStore {
  put(bytes: Uint8Array): Operation<ImmutableObjectRef>;
  get(reference: ImmutableObjectRef): Operation<Uint8Array | null>;
}

/** Deterministic immutable object store with digest verification and copy isolation. */
export class InMemoryImmutableObjectStore implements ImmutableObjectStore {
  private readonly objects = new Map<string, Uint8Array>();

  constructor(
    private readonly provider = "memory",
    private readonly namespace = "deterministic",
  ) {}

  *put(bytes: Uint8Array): Operation<ImmutableObjectRef> {
    const digest = sha256Bytes(bytes);
    this.objects.set(digest, bytes.slice());
    return {
      provider: this.provider,
      namespace: this.namespace,
      key: digest,
      digest,
      bytes: bytes.byteLength,
    };
  }

  *get(reference: ImmutableObjectRef): Operation<Uint8Array | null> {
    const bytes = this.objects.get(reference.digest);
    if (!bytes) {
      return null;
    }
    if (bytes.byteLength !== reference.bytes || sha256Bytes(bytes) !== reference.digest) {
      throw new CrankError("workspace_unavailable", "Materialization integrity check failed");
    }
    return bytes.slice();
  }

  corrupt(digest: string, bytes: Uint8Array): void {
    this.objects.set(digest, bytes.slice());
  }

  delete(digest: string): void {
    this.objects.delete(digest);
  }
}

export function parseSandboxCapabilities(value: unknown): SandboxCapabilities {
  const parsed = sandboxCapabilitiesSchema.safeParse(value);
  if (!parsed.success) {
    throw new CrankError("sandbox_unavailable", "Sandbox capability shape is invalid");
  }
  const capabilities = parsed.data;
  if (
    capabilities.workspacePersistence === "checkpoint_restore" &&
    !capabilities.checkpointRestore
  ) {
    throw new CrankError("sandbox_unavailable", "checkpoint_restore requires checkpointRestore");
  }
  return capabilities;
}

export function sandboxInstanceKey(input: SandboxInstanceKeyInput): string {
  return `sandbox_${sha256(`sweatpants.sandbox-instance.v1\0${canonicalJson(input)}`)}`;
}

export function assertSandboxFence(
  expected: SandboxActivationFence,
  received: SandboxActivationFence,
): void {
  if (expected.taskId !== received.taskId) {
    throw new CrankError("sandbox_generation_stale", "Sandbox task fence mismatch");
  }
  if (
    expected.sandboxGeneration !== received.sandboxGeneration ||
    expected.activationEpoch !== received.activationEpoch
  ) {
    throw new CrankError("sandbox_generation_stale", "Sandbox generation or epoch is stale");
  }
}

export function chooseSandboxRecovery(input: {
  readonly inspection: SandboxInspection | null;
  readonly targetCapabilities: SandboxCapabilities;
  readonly latestWorkspaceVersion?: WorkspaceVersion;
  readonly hasCommittedWorkspaceMutation: boolean;
}): SandboxRecoveryDecision {
  const { inspection, targetCapabilities, latestWorkspaceVersion, hasCommittedWorkspaceMutation } =
    input;
  if (inspection?.state === "running" && inspection.workspace === "present") {
    return { kind: "reuse", inspection };
  }
  if (
    inspection?.state === "suspended" &&
    inspection.workspace === "present" &&
    inspection.capabilities.memorySuspend
  ) {
    return { kind: "resume", inspection };
  }
  if (latestWorkspaceVersion) {
    if (!targetCapabilities.checkpointRestore) {
      throw new CrankError("workspace_unavailable", "Target provider cannot restore workspace");
    }
    return { kind: "restore", workspaceVersion: latestWorkspaceVersion };
  }
  if (hasCommittedWorkspaceMutation) {
    throw new CrankError("workspace_unavailable", "Committed workspace version is unavailable");
  }
  return { kind: "bootstrap" };
}

export function* createWorkspaceVersion(input: {
  readonly store: ImmutableObjectStore;
  readonly workspaceId: string;
  readonly parent?: WorkspaceVersion;
  readonly bytes: Uint8Array;
  readonly kind: "full" | "delta";
  readonly taskId: string;
  readonly sandboxGeneration: string;
  readonly createdAt: string;
}): Operation<WorkspaceVersion> {
  if (input.kind === "delta" && !input.parent) {
    throw new CrankError("workspace_materialization_failed", "Delta requires a parent version");
  }
  const object = yield* input.store.put(input.bytes);
  const verified = yield* input.store.get(object);
  if (!verified || sha256Bytes(verified) !== object.digest) {
    throw new CrankError(
      "workspace_materialization_failed",
      "Materialization was not durably verified",
    );
  }
  const materialization: WorkspaceMaterializationRef = {
    format: "sweatpants.workspace-materialization.v1",
    kind: input.kind,
    object,
    ...(input.parent ? { baseVersionDigest: input.parent.versionDigest } : {}),
    taskId: input.taskId,
    sandboxGeneration: input.sandboxGeneration,
    createdAt: input.createdAt,
  };
  const parentDigest = input.parent?.versionDigest;
  const versionDigest = sha256(
    `sweatpants.workspace-version.v1\0${canonicalJson({
      workspaceId: input.workspaceId,
      parentDigest: parentDigest ?? null,
      kind: input.kind,
      contentDigest: object.digest,
      bytes: object.bytes,
    })}`,
  );
  return {
    format: "sweatpants.workspace-version.v1",
    workspaceId: input.workspaceId,
    versionDigest,
    ...(parentDigest ? { parentDigest } : {}),
    materialization,
  };
}

export function* restoreWorkspaceVersion(
  store: ImmutableObjectStore,
  version: WorkspaceVersion,
): Operation<Uint8Array> {
  if (
    version.materialization.kind === "delta" &&
    version.materialization.baseVersionDigest !== version.parentDigest
  ) {
    throw new CrankError("workspace_unavailable", "Delta base does not match parent version");
  }
  const bytes = yield* store.get(version.materialization.object);
  if (!bytes) {
    throw new CrankError("workspace_unavailable", "Required workspace materialization is missing");
  }
  return bytes;
}

export interface RestoreCreate {
  readonly protocolVersion: 1;
  readonly taskId: string;
  readonly exactProgram: { readonly id: string; readonly version: string; readonly digest: Sha256 };
  readonly collection: ImmutableObjectRef;
  readonly sandboxGeneration: string;
  readonly activationEpoch: number;
  readonly journalHeadDigest: Sha256;
  readonly replayChainSeed: Sha256;
}

export interface ReplayPage {
  readonly restoreId: string;
  readonly pageIndex: number;
  readonly previousPageDigest: Sha256;
  readonly entries: readonly Json[];
  readonly pageDigest: Sha256;
}

export interface RestoreFinish {
  readonly restoreId: string;
  readonly pageCount: number;
  readonly finalPageDigest: Sha256;
  readonly replayChainDigest: Sha256;
  readonly currentCommand?: Json;
}

interface RestoreState {
  readonly create: RestoreCreate;
  readonly expiresAt: number;
  readonly pages: ReplayPage[];
}

export const DEFAULT_REPLAY_PAGE_BYTES = 1024 * 1024;
export const DEFAULT_REPLAY_PAGE_ENTRIES = 1024;
export const DEFAULT_RESTORE_LIFETIME_MS = 5 * 60 * 1000;

export function replayPageDigest(input: Omit<ReplayPage, "pageDigest">): Sha256 {
  return sha256(`sweatpants.replay-page.v1\0${canonicalJson(input)}`);
}

export function replayChainDigest(seed: Sha256, pageDigests: readonly Sha256[]): Sha256 {
  return sha256(`sweatpants.replay-chain.v1\0${canonicalJson({ seed, pages: pageDigests })}`);
}

/** Finite digest-chained restore state machine. Attachments are deliberately outside this authority. */
export class FiniteHttpRestoreProtocol {
  private readonly restores = new Map<string, RestoreState>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limits = {
      pageBytes: DEFAULT_REPLAY_PAGE_BYTES,
      pageEntries: DEFAULT_REPLAY_PAGE_ENTRIES,
      lifetimeMs: DEFAULT_RESTORE_LIFETIME_MS,
    },
  ) {}

  create(request: RestoreCreate): { readonly restoreId: string; readonly expiresAt: number } {
    if (request.protocolVersion !== 1 || request.activationEpoch < 1) {
      throw new CrankError("restore_page_mismatch", "Invalid restore binding");
    }
    const restoreId = `restore_${sha256(`sweatpants.restore.v1\0${canonicalJson(request)}`).slice(0, 32)}`;
    const existing = this.restores.get(restoreId);
    if (existing && existing.expiresAt > this.now()) {
      if (canonicalJson(existing.create) !== canonicalJson(request)) {
        throw new CrankError("restore_page_mismatch", "Restore identifier binding conflict");
      }
      return { restoreId, expiresAt: existing.expiresAt };
    }
    if (existing) {
      this.restores.delete(restoreId);
    }
    const expiresAt = this.now() + this.limits.lifetimeMs;
    this.restores.set(restoreId, {
      create: canonicalSnapshot(request).value,
      expiresAt,
      pages: [],
    });
    return { restoreId, expiresAt };
  }

  append(page: ReplayPage): { readonly status: "accepted" | "duplicate" } {
    const state = this.requireState(page.restoreId);
    if (
      page.entries.length > this.limits.pageEntries ||
      new TextEncoder().encode(canonicalJson(page.entries)).byteLength > this.limits.pageBytes
    ) {
      throw new CrankError("payload_too_large", "Replay page exceeds configured limit");
    }
    const expectedIndex = state.pages.length;
    if (page.pageIndex < expectedIndex) {
      const existing = state.pages[page.pageIndex];
      if (existing && canonicalJson(existing) === canonicalJson(page)) {
        return { status: "duplicate" };
      }
      throw new CrankError("restore_page_mismatch", "Conflicting duplicate replay page");
    }
    if (page.pageIndex !== expectedIndex) {
      throw new CrankError("restore_page_out_of_order");
    }
    const previous =
      expectedIndex === 0
        ? state.create.replayChainSeed
        : state.pages[expectedIndex - 1]!.pageDigest;
    if (page.previousPageDigest !== previous) {
      throw new CrankError("restore_page_out_of_order", "Replay chain predecessor mismatch");
    }
    const expectedDigest = replayPageDigest({
      restoreId: page.restoreId,
      pageIndex: page.pageIndex,
      previousPageDigest: page.previousPageDigest,
      entries: page.entries,
    });
    if (page.pageDigest !== expectedDigest) {
      throw new CrankError("restore_page_mismatch", "Replay page digest mismatch");
    }
    state.pages.push(canonicalSnapshot(page).value);
    return { status: "accepted" };
  }

  finish(request: RestoreFinish): {
    readonly entries: readonly Json[];
    readonly currentCommand?: Json;
  } {
    const state = this.requireState(request.restoreId);
    if (request.pageCount !== state.pages.length) {
      throw new CrankError("restore_page_out_of_order", "Restore has missing pages");
    }
    const finalPageDigest = state.pages.at(-1)?.pageDigest ?? state.create.replayChainSeed;
    const expectedReplayChainDigest = replayChainDigest(
      state.create.replayChainSeed,
      state.pages.map((page) => page.pageDigest),
    );
    if (
      request.finalPageDigest !== finalPageDigest ||
      request.replayChainDigest !== expectedReplayChainDigest
    ) {
      throw new CrankError("restore_page_mismatch", "Restore frontier digest mismatch");
    }
    this.restores.delete(request.restoreId);
    return {
      entries: state.pages.flatMap((page) => structuredClone(page.entries)),
      ...(request.currentCommand === undefined
        ? {}
        : { currentCommand: canonicalSnapshot(request.currentCommand).value }),
    };
  }

  private requireState(restoreId: string): RestoreState {
    const state = this.restores.get(restoreId);
    if (!state) {
      throw new CrankError("restore_required");
    }
    if (state.expiresAt <= this.now()) {
      this.restores.delete(restoreId);
      throw new CrankError("restore_expired");
    }
    return state;
  }
}
