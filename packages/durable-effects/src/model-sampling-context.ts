import { createContext, type Operation } from "effection";

import type { Json } from "@sweatpants/foundation";

export interface ProgramPlacementContextValue {
  readonly journal: { readonly id: string; readonly incarnation: string };
  readonly program: { readonly id: string; readonly version: string; readonly digest: string };
  readonly route: Json;
  readonly driverKind: string;
}

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

/** Host-owned append capability. It deliberately exposes no read or crank APIs. */
export interface ProgramDeliveryWriter {
  append(events: readonly ProgramDeliveryEnvelope[]): Operation<number>;
}

export const ProgramPlacementContext = createContext<ProgramPlacementContextValue | undefined>(
  "durable-effects:model-sampling-placement",
  undefined,
);
export const ProgramDeliveryWriterContext = createContext<ProgramDeliveryWriter | undefined>(
  "durable-effects:model-sampling-delivery-writer",
  undefined,
);
