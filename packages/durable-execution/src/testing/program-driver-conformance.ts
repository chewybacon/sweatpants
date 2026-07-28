import { canonicalJson, type Json } from "@sweatpants/foundation";
import type { OperationOutcome } from "@sweatpants/durable-effects/contract";
import type { PinnedProgram } from "../program-contract.ts";

export interface NormalizedProgramOperationTrace {
  actionIndex: number;
  pullId: string;
  descriptor: Json;
  outcome?: OperationOutcome;
}

export interface NormalizedProgramTaskTrace {
  taskId: string;
  turnId: string;
  parentTaskId?: string;
  parentPullId?: string;
  program: PinnedProgram;
  acceptedInput: Json;
  catalogDigest?: string;
  operations: NormalizedProgramOperationTrace[];
  semanticEmissions: Json[];
  cancellations: Json[];
  terminal?: OperationOutcome;
}

export interface NormalizedProgramTrace {
  version: 1;
  tasks: NormalizedProgramTaskTrace[];
}

export interface ProgramDriverConformanceCase {
  name: string;
  expected: NormalizedProgramTrace;
  execute(): Promise<NormalizedProgramTrace>;
}

export interface ProgramDriverConformanceEvidence {
  name: string;
  trace: NormalizedProgramTrace;
}

/** Provider-neutral runner: adapters supply execution, the core compares only semantic traces. */
export async function runProgramDriverConformance(
  testCase: ProgramDriverConformanceCase,
): Promise<ProgramDriverConformanceEvidence> {
  const trace = await testCase.execute();
  const divergence = firstTraceDivergence(testCase.expected, trace);
  if (divergence) {
    throw new Error(
      `ProgramDriver conformance diverged at ${divergence.path}: expected ${display(
        divergence.expected,
      )}, received ${display(divergence.actual)}`,
    );
  }
  return { name: testCase.name, trace };
}

export function firstTraceDivergence(
  expected: unknown,
  actual: unknown,
  path = "$",
): { path: string; expected: unknown; actual: unknown } | undefined {
  if (Object.is(expected, actual)) {
    return undefined;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      const found = firstTraceDivergence(expected[index], actual[index], `${path}[${index}]`);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (isRecord(expected) && isRecord(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      const found = firstTraceDivergence(expected[key], actual[key], `${path}.${key}`);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  return { path, expected, actual };
}

function display(value: unknown): string {
  if (value === undefined) {
    return "<missing>";
  }
  return canonicalJson(value as Json);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
