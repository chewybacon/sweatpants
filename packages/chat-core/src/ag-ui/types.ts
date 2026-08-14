import type { RunStartedEvent } from "@ag-ui/core";
import type { Json } from "@sweatpants/foundation";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import type { PublicActivityPlacement } from "../chat-client-types.ts";
import type { ConversationStreamEvent } from "../conversation-protocol.ts";

type TreePlacement = Omit<PublicActivityPlacement, "presentation">;

/** Producer facts retained by internal checkpoint and execution contracts. */
export type AgUiRunMetadata = Pick<RunStartedEvent, "threadId" | "runId" | "parentRunId">;

export interface AgUiCustomState {
  pendingClientActions?: Array<{
    toolCallId: string;
    toolName: string;
    kind: "elicit";
    sessionId: string;
    elicitId: string;
    key: string;
    message: string;
    schema?: Record<string, unknown>;
    bindingId?: string;
    context?: Json;
    responseContract?: PortableSchemaDescriptor;
    contextContract?: PortableSchemaDescriptor;
    placement?: TreePlacement;
  }>;
}

/** Internal runtime request shape. Public streams represent this as an AG-UI interrupt. */
export interface ElicitRequestStreamEvent {
  type: "elicit_request";
  sessionId: string;
  callId: string;
  toolName: string;
  elicitId: string;
  key: string;
  message: string;
  schema?: Record<string, unknown>;
  bindingId?: string;
  context?: Json;
  responseContract?: PortableSchemaDescriptor;
  contextContract?: PortableSchemaDescriptor;
  placement?: TreePlacement;
}

/** Standard protocol events are the official AG-UI union, without handwritten duplicates. */
export interface DurableFrame {
  readonly lsn: number;
  readonly event: ConversationStreamEvent;
}
