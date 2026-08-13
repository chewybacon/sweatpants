import { ConversationStoreError } from "./contract.ts";

export const CHECKPOINT_BOUNDS = Object.freeze({
  maxTotalBytes: 8 * 1024 * 1024,
  maxTotalRoots: 256,
  maxMutableRoots: 64,
  maxOpenInterrupts: 64,
  maxInlineRootBytes: 1024 * 1024,
});

export interface CheckpointBoundInput {
  readonly encodedBytes: number;
  readonly totalRoots: number;
  readonly mutableRoots: number;
  readonly openInterrupts: number;
  readonly largestInlineRootBytes: number;
}

export class CheckpointBoundExceededError extends ConversationStoreError {
  constructor(
    readonly field: keyof CheckpointBoundInput,
    readonly actual: number,
    readonly maximum: number,
  ) {
    super("checkpoint_bound_exceeded", `Checkpoint ${field} ${actual} exceeds maximum ${maximum}`);
    this.name = "CheckpointBoundExceededError";
  }
}

export function assertCheckpointBounds(input: CheckpointBoundInput): void {
  const checks: Array<[keyof CheckpointBoundInput, number, number]> = [
    ["encodedBytes", input.encodedBytes, CHECKPOINT_BOUNDS.maxTotalBytes],
    ["totalRoots", input.totalRoots, CHECKPOINT_BOUNDS.maxTotalRoots],
    ["mutableRoots", input.mutableRoots, CHECKPOINT_BOUNDS.maxMutableRoots],
    ["openInterrupts", input.openInterrupts, CHECKPOINT_BOUNDS.maxOpenInterrupts],
    ["largestInlineRootBytes", input.largestInlineRootBytes, CHECKPOINT_BOUNDS.maxInlineRootBytes],
  ];
  for (const [field, actual, maximum] of checks) {
    if (!Number.isSafeInteger(actual) || actual < 0 || actual > maximum) {
      throw new CheckpointBoundExceededError(field, actual, maximum);
    }
  }
}
