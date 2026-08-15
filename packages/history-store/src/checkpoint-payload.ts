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
  readonly applicationState: Json;
}

export interface ConversationCheckpointPayload {
  readonly public: CheckpointPublicProjection;
}

function record(value: Json, path: string): Readonly<Record<string, Json>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CheckpointPayloadError(`${path} must be an object`);
  }
  return value;
}

function exactKeys(
  value: Readonly<Record<string, Json>>,
  expected: readonly string[],
  path: string,
): void {
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key))
  ) {
    throw new CheckpointPayloadError(`${path} has an invalid persisted shape`);
  }
}

function validateRoot(root: Json, index: number): void {
  const value = record(root, `checkpoint.public.hotRoots[${index}]`);
  if (
    typeof value["rootId"] !== "string" ||
    typeof value["position"] !== "string" ||
    !/^(0|[1-9]\d*)$/.test(value["position"]) ||
    !(value["kind"] === "message" || value["kind"] === "activity-subtree") ||
    !(value["state"] === "mutable" || value["state"] === "sealed")
  ) {
    throw new CheckpointPayloadError(
      `checkpoint.public.hotRoots[${index}] is not a typed positioned public root`,
    );
  }
}

export function isConversationCheckpointPayload(
  value: Json,
): value is Json & ConversationCheckpointPayload {
  try {
    assertCheckpointPayload(value);
    return true;
  } catch {
    return false;
  }
}

export function assertCheckpointPayload(value: Json): ConversationCheckpointPayload {
  const envelope = record(value, "checkpoint");
  exactKeys(envelope, ["public"], "checkpoint");
  const projection = record(envelope["public"]!, "checkpoint.public");
  exactKeys(projection, ["hotRoots", "applicationState"], "checkpoint.public");
  if (!Array.isArray(projection["hotRoots"])) {
    throw new CheckpointPayloadError("checkpoint.public.hotRoots must be an array");
  }
  projection["hotRoots"].forEach(validateRoot);
  if (projection["applicationState"] === undefined) {
    throw new CheckpointPayloadError("checkpoint.public.applicationState is required");
  }
  return value as Json & ConversationCheckpointPayload;
}

export function checkpointHotRoots(value: Json): readonly Json[] {
  return assertCheckpointPayload(value).public.hotRoots;
}

export function checkpointHotSealedRootCount(value: Json): number {
  return checkpointHotRoots(value).filter(
    (root) =>
      root !== null &&
      typeof root === "object" &&
      !Array.isArray(root) &&
      root["state"] === "sealed",
  ).length;
}

export function checkpointPublicApplicationState(value: Json): Json {
  return assertCheckpointPayload(value).public.applicationState;
}

export function checkpointPayloadFromHotRoots(
  hotRoots: readonly Json[],
  applicationState: Json = {},
): Json {
  const payload: Json = {
    public: {
      hotRoots: [...hotRoots],
      applicationState,
    },
  };
  assertCheckpointPayload(payload);
  return payload;
}
