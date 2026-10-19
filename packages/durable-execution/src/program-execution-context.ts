import { createContext, type Operation } from "effection";
import { stableTupleHash, cloneJson } from "@sweatpants/foundation";

import { CrankError } from "./errors.ts";
import type { AttachProgramRequest, ProgramRoute } from "./program-driver-contract.ts";
import type { PinnedProgram, SandboxAffinity } from "./program-contract.ts";

export const PROGRAM_EXECUTION_FORMAT = "sweatpants.program-execution.v1" as const;

/** Attachment-local identity exposed to deployment-owned ordinary APIs. */
export interface ProgramExecutionValue {
  readonly format: typeof PROGRAM_EXECUTION_FORMAT;
  readonly identity: {
    readonly sessionId: string;
    readonly taskId: string;
    readonly program: PinnedProgram;
  };
  readonly attempt: {
    readonly attachmentId: string;
    readonly executionEpoch: number;
    readonly route: ProgramRoute;
  };
  readonly affinity: SandboxAffinity;
  operationId(namespace: string): string;
}

export const ProgramExecutionContext = createContext<ProgramExecutionValue | undefined>(
  "durable-execution:program-execution-v1",
  undefined,
);

export function* useProgramExecution(): Operation<ProgramExecutionValue> {
  const value = yield* ProgramExecutionContext.get();
  if (!value) {
    throw new CrankError(
      "program_execution_unavailable",
      "Program execution context is unavailable outside a program attachment",
    );
  }
  return value;
}

export function createProgramExecutionValue(
  request: AttachProgramRequest,
  attachmentId: string,
): ProgramExecutionValue {
  const route = cloneJson(request.route);
  assertNoAuthorityMaterial(route);
  const affinity = acceptedAffinity(request, route);
  let callIndex = 0;
  const identity = Object.freeze({
    sessionId: boundedText(request.sessionId, "sessionId"),
    taskId: boundedText(request.taskId, "taskId"),
    program: Object.freeze({ ...request.program }),
  });
  const attempt = Object.freeze({
    attachmentId: boundedText(attachmentId, "attachmentId"),
    executionEpoch: request.executionEpoch,
    route,
  });
  return Object.freeze({
    format: PROGRAM_EXECUTION_FORMAT,
    identity,
    attempt,
    affinity,
    operationId(namespace: string) {
      callIndex += 1;
      return stableTupleHash([
        "program-operation-attempt-v1",
        identity.sessionId,
        identity.taskId,
        identity.program.id,
        identity.program.version,
        identity.program.digest,
        attempt.attachmentId,
        attempt.executionEpoch,
        boundedNamespace(namespace),
        callIndex,
      ]);
    },
  });
}

function acceptedAffinity(request: AttachProgramRequest, route: ProgramRoute): SandboxAffinity {
  if (request.affinity) {
    return freezeAffinity(request.affinity);
  }
  if (route && typeof route === "object" && !Array.isArray(route)) {
    const candidate = route["affinity"];
    if (isAffinity(candidate)) {
      return freezeAffinity(candidate);
    }
  }
  return freezeAffinity({ kind: "invocation", key: request.taskId });
}

function isAffinity(value: unknown): value is SandboxAffinity {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ["invocation", "conversation", "workspace"].includes(
      String((value as Record<string, unknown>)["kind"]),
    ) &&
    typeof (value as Record<string, unknown>)["key"] === "string",
  );
}

function freezeAffinity(value: SandboxAffinity): SandboxAffinity {
  if (!isAffinity(value)) {
    throw new CrankError("invalid_descriptor", "Program affinity is invalid");
  }
  return Object.freeze({ kind: value.kind, key: boundedText(value.key, "affinity.key") });
}

function assertNoAuthorityMaterial(value: unknown, path = "route"): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoAuthorityMaterial(child, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/(?:capabilit|credential|secret|password|signing|authorization|authToken)/i.test(key)) {
      throw new CrankError(
        "invalid_descriptor",
        `Program execution route contains forbidden authority material at ${path}.${key}`,
      );
    }
    assertNoAuthorityMaterial(child, `${path}.${key}`);
  }
}

function boundedNamespace(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value)) {
    throw new CrankError("invalid_descriptor", "Operation namespace must be bounded text");
  }
  return value;
}

function boundedText(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).length > 512
  ) {
    throw new CrankError("invalid_descriptor", `${field} must be bounded text`);
  }
  return value;
}
