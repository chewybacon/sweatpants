import { CrankError } from "@sweatpants/durable-execution";
import { type Json } from "@sweatpants/foundation";
import {
  type DurableTool,
  type PinnedProgram,
  type ProgramIdentityProvenanceV1,
} from "@sweatpants/durable-execution";
import { type SchemaBinding } from "@sweatpants/foundation/schema-descriptor";

export const RESOURCE_PACKAGE_FORMAT = "sweatpants.resource-package.v1" as const;
export const RESOURCE_PACKAGE_DOMAIN = `${RESOURCE_PACKAGE_FORMAT}\n`;
export const RESOURCE_VIEW_FORMAT = "sweatpants.resource-view.v1" as const;
export const RESOURCE_SEARCH_MATCH_SEMANTICS = "first-match-per-file" as const;
export const RESOURCE_SEARCH_MAX_QUERY_BYTES = 4096;
export const RESOURCE_SEARCH_EXCERPT_CODE_UNITS = 512;
export type ReaderOperation = "stat" | "list" | "read" | "search";

export const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  maxFiles: 4096,
  maxPathBytes: 512,
  maxFileBytes: 16 * 1024 * 1024,
  maxPackageBytes: 64 * 1024 * 1024,
  maxReadBytes: 256 * 1024,
  maxListEntries: 1024,
  maxSearchMatches: 256,
} as const);

export interface ResourceLimits {
  readonly maxFiles: number;
  readonly maxPathBytes: number;
  readonly maxFileBytes: number;
  readonly maxPackageBytes: number;
  readonly maxReadBytes: number;
  readonly maxListEntries: number;
  readonly maxSearchMatches: number;
}

export type ResourceErrorCode =
  | "invalid_resource_manifest"
  | "invalid_resource_path"
  | "resource_limit_exceeded"
  | "resource_digest_mismatch"
  | "resource_identity_mismatch"
  | "resource_not_found"
  | "resource_access_denied"
  | "resource_mount_conflict"
  | "resource_read_too_large"
  | "unsupported_resource_projection"
  | "stale_generated_resource_package"
  | "stale_generated_program_identity"
  | "asserted_program_identity_forbidden";

/** Content-safe public resource failure. Details never include bytes or host paths. */
export class ResourceError extends CrankError {
  readonly _resourceTag = "ResourceError";
  constructor(code: ResourceErrorCode, message: string = code) {
    super(code, message);
    this.name = "ResourceError";
  }
}

export interface ResourceFileManifestV1 {
  readonly digest: string;
  readonly size: number;
  readonly mediaType: string;
}

export interface ResourcePackageManifestV1 {
  readonly format: typeof RESOURCE_PACKAGE_FORMAT;
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly files: Readonly<Record<string, ResourceFileManifestV1>>;
}

export interface ResourceFileDeclaration {
  readonly kind: "text" | "json" | "binary";
  readonly mediaType: string;
}

export interface ResourceContentBindings {
  readonly size: number;
  has(path: string): boolean;
  paths(): readonly string[];
  read(path: string): Uint8Array | undefined;
}

export interface ResourcePackage {
  readonly manifest: ResourcePackageManifestV1;
  readonly bindings: ResourceContentBindings;
  readonly limits: ResourceLimits;
}

export type DataClassification = "public" | "internal" | "confidential" | "restricted";

export type ResourceMountAccess =
  | { readonly kind: "program_private" }
  | { readonly kind: "model_readable"; readonly classification: DataClassification }
  | { readonly kind: "tool_scoped"; readonly tools: readonly PinnedProgram[] };

export interface ResourceMount {
  readonly root: string;
  readonly package: ResourcePackage;
  readonly access: ResourceMountAccess;
}

export interface ResourceView {
  readonly format: typeof RESOURCE_VIEW_FORMAT;
  readonly digest: string;
  readonly mounts: readonly ResourceMount[];
  readonly limits: ResourceLimits;
}

export type ResourceConsumer =
  | { readonly kind: "program" }
  | { readonly kind: "model" }
  | { readonly kind: "tool"; readonly program: PinnedProgram };

export interface ResourceFileRefV1 {
  readonly packageId: string;
  readonly packageDigest: string;
  readonly path: string;
}

export interface ResourceSourceProvenance {
  readonly packageDigest: string;
  readonly fileDigest: string;
}

export interface ResourceValueProvenance {
  readonly classifications: readonly DataClassification[];
  readonly sources: readonly ResourceSourceProvenance[];
}

export interface ResourceStatResult extends ResourceValueProvenance {
  readonly ref: ResourceFileRefV1;
  readonly uri: string;
  readonly mediaType: string;
  readonly size: number;
  readonly fileDigest: string;
}

export interface ResourceListEntry {
  readonly logicalPath: string;
  readonly ref: ResourceFileRefV1;
  readonly uri: string;
  readonly mediaType: string;
  readonly size: number;
  readonly fileDigest: string;
  readonly classification?: DataClassification;
}

export interface ResourceListResult extends ResourceValueProvenance {
  readonly entries: readonly ResourceListEntry[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

export type ResourceReadResult =
  | (ResourceValueProvenance & {
      readonly kind: "text";
      readonly text: string;
      readonly mediaType: string;
      readonly packageDigest: string;
      readonly fileDigest: string;
    })
  | (ResourceValueProvenance & {
      readonly kind: "json";
      readonly value: Json;
      readonly mediaType: "application/json";
      readonly packageDigest: string;
      readonly fileDigest: string;
    })
  | (ResourceValueProvenance & {
      readonly kind: "bytes";
      readonly bytesBase64: string;
      readonly mediaType: string;
      readonly packageDigest: string;
      readonly fileDigest: string;
    });

export interface GuidanceDefinition {
  readonly id: string;
  readonly summary: string;
  readonly package: ResourcePackage;
  readonly entryPath: string;
  readonly entryUri: string;
}

export interface GuidanceIndexEntry {
  readonly id: string;
  readonly summary: string;
  readonly entryUri: string;
}

/** Stable nonmutating sort compatible with the repository's ES2022 runtime target. */
export function sortedResourceValues<T>(
  values: Iterable<T>,
  compare: (left: T, right: T) => number,
): T[] {
  const result: T[] = [];
  for (const value of values) {
    let index = 0;
    while (index < result.length && compare(result[index]!, value) <= 0) {
      index += 1;
    }
    result.splice(index, 0, value);
  }
  return result;
}

export interface ResourceReaderProgram extends DurableTool {
  /** Exact input/output validators to install with this generated child. */
  readonly schemaCatalog: readonly SchemaBinding[];
}

export interface ResourceReaderPrograms {
  readonly stat: ResourceReaderProgram;
  readonly list: ResourceReaderProgram;
  readonly read: ResourceReaderProgram;
  readonly search: ResourceReaderProgram;
  readonly provenance: ProgramIdentityProvenanceV1;
}
