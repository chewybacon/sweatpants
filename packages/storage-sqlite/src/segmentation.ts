export {
  DEFAULT_CHECKPOINT_SPILL_TARGET,
  DEFAULT_CHECKPOINT_TARGETS,
  DEFAULT_PUBLIC_SEGMENT_TARGET,
  LOW_CHECKPOINT_SPILL_TARGET,
  LOW_CHECKPOINT_TARGETS,
  LOW_PUBLIC_SEGMENT_TARGET,
  encodedJsonBytes,
  rootPayloadBytes,
  segmentValues,
  spillEligibleRoots,
  spillUntilWithinTarget,
  type CheckpointPublicationTargets,
  type CheckpointSpillTarget,
  type SegmentTarget,
  type SegmentedValues,
} from "@sweatpants/history-store";

export const DEFAULT_PRIVATE_SEGMENT_TARGET = Object.freeze({
  maxEntries: 256,
  maxEncodedBytes: 256 * 1024,
});

export const LOW_PRIVATE_SEGMENT_TARGET = Object.freeze({
  maxEntries: 10,
  maxEncodedBytes: 8 * 1024,
});
