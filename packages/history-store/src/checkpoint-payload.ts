import type { Json } from "@sweatpants/foundation";

export class CheckpointPayloadError extends Error {
  readonly code = "persisted_data_invalid";

  constructor(message: string) {
    super(message);
    this.name = "CheckpointPayloadError";
  }
}

export interface CheckpointPublicProjection {
  readonly hotRoots: readonly Json[];
  /** Number of hot roots that are sealed and eligible for archival spill. */
  readonly sealedRootCount?: number;
}

export interface ConversationCheckpointPayload {
  readonly public: CheckpointPublicProjection;
}

export function isConversationCheckpointPayload(
  value: Json,
): value is Json & ConversationCheckpointPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if ("version" in value) {
    return false;
  }
  const projection = value["public"];
  if (projection === null || typeof projection !== "object" || Array.isArray(projection)) {
    return false;
  }
  if (!Array.isArray(projection["hotRoots"])) {
    return false;
  }
  const sealedRootCount = projection["sealedRootCount"];
  return (
    sealedRootCount === undefined ||
    (typeof sealedRootCount === "number" &&
      Number.isSafeInteger(sealedRootCount) &&
      sealedRootCount >= 0 &&
      sealedRootCount <= projection["hotRoots"].length)
  );
}

export function assertCheckpointPayload(value: Json): ConversationCheckpointPayload {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && "version" in value) {
    throw new CheckpointPayloadError(
      "Persisted checkpoint envelopes must not contain a version field",
    );
  }
  if (!isConversationCheckpointPayload(value)) {
    throw new CheckpointPayloadError(
      "Checkpoint payload must be { public: { hotRoots } } without a growing events envelope",
    );
  }
  return value;
}

export function checkpointHotRoots(value: Json): readonly Json[] {
  return assertCheckpointPayload(value).public.hotRoots;
}

export function checkpointHotSealedRootCount(value: Json): number {
  return assertCheckpointPayload(value).public.sealedRootCount ?? 0;
}

export function checkpointPayloadFromHotRoots(
  hotRoots: readonly Json[],
  sealedRootCount = 0,
): Json {
  if (
    !Number.isSafeInteger(sealedRootCount) ||
    sealedRootCount < 0 ||
    sealedRootCount > hotRoots.length
  ) {
    throw new CheckpointPayloadError("Checkpoint sealed root count is invalid");
  }
  return sealedRootCount === 0
    ? { public: { hotRoots: [...hotRoots] } }
    : { public: { hotRoots: [...hotRoots], sealedRootCount } };
}
