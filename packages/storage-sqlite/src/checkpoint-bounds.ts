// Compatibility export. Checkpoint bounds are mandatory conversation semantics,
// not SQLite policy, and therefore live with the shared semantic repository.
export {
  assertCheckpointBounds,
  CHECKPOINT_BOUNDS,
  CheckpointBoundExceededError,
  type CheckpointBoundInput,
} from "@sweatpants/history-store";
