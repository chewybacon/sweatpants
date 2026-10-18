import { createContext, type Operation } from "effection";
import type { Json } from "@sweatpants/foundation";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import type {
  DurableOperationDescriptor,
  EmissionDescriptor,
  RecordAttemptContext,
} from "@sweatpants/durable-execution";

/** A closed marker carried by durable boundaries. Ephemeral markers never leave the attachment. */
export type SerializableProgramProposal =
  | {
      readonly type: "operation";
      readonly descriptor: DurableOperationDescriptor;
    }
  | {
      readonly type: "emission";
      readonly descriptor: EmissionDescriptor;
    }
  | { readonly type: "ephemeral" };

export interface RuntimeRecordBoundary<T extends Json> {
  readonly serializable: Extract<SerializableProgramProposal, { readonly type: "operation" }>;
  readonly execute: (attempt: RecordAttemptContext) => Operation<T>;
}

export interface ProgramEffectRuntime {
  perform<T extends Json>(boundary: RuntimeRecordBoundary<T>): Operation<OperationOutcome>;
  requestEmission(descriptor: EmissionDescriptor): Operation<Json>;
}

/** Scoped effect boundary: containers and evaluator resources install their own runtime. */
export const ProgramEffectRuntimeContext = createContext<ProgramEffectRuntime>(
  "journal-authority:program-effect-runtime",
);
