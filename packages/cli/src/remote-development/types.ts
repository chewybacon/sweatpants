export const DEVELOPMENT_COLLECTION_FORMAT = "sweatpants.development-collection.v1" as const;
export const DEVELOPMENT_COLLECTION_DOMAIN = `${DEVELOPMENT_COLLECTION_FORMAT}\n`;
export const PUBLISHED_COLLECTION_FORMAT = "sweatpants.published-collection.v1" as const;
export const ACTIVE_COLLECTION_FORMAT = "sweatpants.active-collection.v1" as const;

export type Sha256 = string;

export interface CollectionFileEntryV1 {
  readonly path: string;
  readonly bytes: number;
  readonly digest: Sha256;
  readonly kind: "program" | "schema-catalog" | "resource-descriptor" | "registry";
}

export interface CollectionProgramEntryV1 {
  readonly publicKey: string;
  readonly programId: string;
  readonly version: string;
  readonly compatibilityMajor: number;
  readonly manifestDigest: Sha256;
  readonly entrypoint: string;
  readonly implementationArtifactDigest: Sha256;
  readonly schemaCatalogDigest: Sha256;
  readonly resourcePackageDigests: readonly Sha256[];
}

export interface DevelopmentCollectionManifestV1 {
  readonly format: typeof DEVELOPMENT_COLLECTION_FORMAT;
  readonly builder: {
    readonly name: "@sweatpants/cli";
    readonly version: string;
  };
  readonly collectionDigest: Sha256;
  readonly evaluatorAbi: string;
  readonly target: {
    readonly runtime: "node";
    readonly module: "esm";
    readonly platform: string;
  };
  readonly programs: Readonly<Record<string, CollectionProgramEntryV1>>;
  readonly files: readonly CollectionFileEntryV1[];
}

export interface PublishedCollectionRefV1 {
  readonly format: typeof PUBLISHED_COLLECTION_FORMAT;
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  readonly objectDigest: Sha256;
  readonly collectionDigest: Sha256;
  readonly bytes: number;
  readonly publishedAt: string;
  readonly expiresAt?: string;
}

export interface DevelopmentEnvironmentIdentityV1 {
  readonly accountId: string;
  readonly region: string;
  readonly project: string;
  readonly owner: string;
  readonly name: string;
}

export interface ActiveCollectionRecordV1 {
  readonly format: typeof ACTIVE_COLLECTION_FORMAT;
  readonly environment: DevelopmentEnvironmentIdentityV1;
  readonly epoch: number;
  readonly writerId: string;
  readonly collection: PublishedCollectionRefV1;
  readonly evaluatorReleaseId: string;
  readonly evaluatorAbi: string;
  readonly readinessDigest: Sha256;
  readonly activatedAt: string;
  readonly previousCollectionDigest?: Sha256;
}

export type RemoteDevelopmentErrorCode =
  | "invalid_remote_config"
  | "invalid_program_root"
  | "invalid_semver"
  | "non_release_strict_program"
  | "nondeterministic_bundle"
  | "invalid_collection_manifest"
  | "artifact_digest_mismatch"
  | "collection_digest_mismatch"
  | "object_digest_mismatch"
  | "prohibited_runtime_import"
  | "environment_not_found"
  | "environment_drift"
  | "aws_authentication_failed"
  | "aws_authorization_failed"
  | "approval_required"
  | "activation_authority_lost"
  | "collection_not_ready"
  | "evaluator_abi_mismatch"
  | "program_major_unavailable"
  | "release_expired"
  | "contract_major_mismatch"
  | "replay_shape_mismatch"
  | "nondeterminism_detected"
  | "recorded_contract_validation_failed"
  | "sandbox_task_mismatch"
  | "stale_activation"
  | "agentcore_transport_lost"
  | "agentcore_session_not_found"
  | "placement_unavailable"
  | "cleanup_incomplete";

export interface RemoteDevelopmentDiagnosticV1 {
  readonly code: RemoteDevelopmentErrorCode;
  readonly message: string;
  readonly environment?: string;
  readonly collectionDigest?: Sha256;
  readonly programId?: string;
  readonly compatibilityMajor?: number;
  readonly programArtifactDigest?: Sha256;
  readonly journalIdHash?: Sha256;
  readonly taskId?: string;
  readonly runtimeSessionId?: string;
  readonly activationEpoch?: number;
  readonly evaluatorReleaseId?: string;
  readonly evaluatorAbi?: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export class RemoteDevelopmentError extends Error {
  readonly code: RemoteDevelopmentErrorCode;
  readonly diagnostic: RemoteDevelopmentDiagnosticV1;

  constructor(
    code: RemoteDevelopmentErrorCode,
    message: string,
    details: Omit<RemoteDevelopmentDiagnosticV1, "code" | "message"> = {},
  ) {
    super(message);
    this.name = "RemoteDevelopmentError";
    this.code = code;
    this.diagnostic = Object.freeze({ code, message, ...details });
  }
}
