import { createContext, type Operation } from "effection";

export interface DurableEffectOutcomeAcknowledgement {
  readonly effect: { readonly name: string; readonly version: string };
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly attemptId: string;
  readonly outcomeDigest: string;
}

/** Nonsemantic cleanup hook called only after accepted/duplicate journal resolution. */
export type DurableEffectOutcomeAcknowledger = (
  acknowledgement: DurableEffectOutcomeAcknowledgement,
) => Operation<void>;

export const DurableEffectOutcomeAcknowledgerContext = createContext<
  DurableEffectOutcomeAcknowledger | undefined
>("durable-effects:outcome-acknowledger", undefined);
