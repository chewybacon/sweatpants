import type { Json } from "@sweatpants/foundation";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import type { TreePlacement } from "../recursive-tree.ts";

/** Host-owned pending elicitation projection. */
export interface ElicitState {
  elicitId: string;
  sessionId: string;
  callId: string;
  toolName: string;
  key: string;
  message: string;
  bindingId?: string;
  responseContract?: PortableSchemaDescriptor;
  contextContract?: PortableSchemaDescriptor;
  placement?: TreePlacement;
  seq?: number;
  context?: Json;
  /** Boundary-only legacy response projection for protocol adapters. */
  schema?: Record<string, unknown>;
  status: "pending" | "responded" | "cancelled";
  response?: unknown;
  timestamp: number;
}

export interface ElicitTrackingState {
  callId: string;
  toolName: string;
  elicitations: ElicitState[];
  status: "awaiting_elicit" | "complete" | "error" | "cancelled";
  startedAt: number;
}
