import { createContext, type Operation } from "effection";
import { createApi } from "effection/experimental";
import type { Json } from "@sweatpants/foundation";

export interface ProgramDeliveryEnvelope {
  readonly version: 1;
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId?: string;
  readonly messageId?: string;
  readonly origin?: {
    readonly kind: "agentcore-model-sample";
    readonly streamId: string;
    readonly lsn: number;
    readonly producerEpoch: number;
  };
  readonly event: Json;
}

/** Host-owned append capability used by remote model-sampling placement. */
export interface ProgramDeliveryWriter {
  append(events: readonly ProgramDeliveryEnvelope[]): Operation<number>;
}

export class ProgramDeliveryUnavailable extends Error {
  readonly code = "program_delivery_unavailable";

  constructor() {
    super("No program delivery writer is installed");
    this.name = "ProgramDeliveryUnavailable";
  }
}

const ProgramDeliveryWriterContext = createContext<ProgramDeliveryWriter | undefined>(
  "model-sampling:delivery-writer",
  undefined,
);

export const ProgramDeliveryApi = createApi("model-sampling:delivery", {
  *append(events: readonly ProgramDeliveryEnvelope[]): Operation<number> {
    const writer = yield* ProgramDeliveryWriterContext.get();
    if (!writer) throw new ProgramDeliveryUnavailable();
    return yield* writer.append(events);
  },
  *installed(): Operation<boolean> {
    return (yield* ProgramDeliveryWriterContext.get()) !== undefined;
  },
});

export function runWithProgramDeliveryWriter<T>(
  writer: ProgramDeliveryWriter | undefined,
  operation: () => Operation<T>,
): Operation<T> {
  return ProgramDeliveryWriterContext.with(writer, operation);
}
