import { createContext, type Operation } from "effection";

export interface ModelSamplingOutcomeAcknowledgement {
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly attemptId: string;
  readonly outcomeDigest: string;
}

/** Nonsemantic cleanup hook called only after accepted/duplicate journal resolution. */
export type ModelSamplingOutcomeAcknowledger = (
  acknowledgement: ModelSamplingOutcomeAcknowledgement,
) => Operation<void>;

export const ModelSamplingOutcomeAcknowledgerContext = createContext<
  ModelSamplingOutcomeAcknowledger | undefined
>("session-contract:model-sampling-outcome-acknowledger", undefined);
