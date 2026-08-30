import type { Json } from "@sweatpants/foundation";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema";

export interface PublicActivityPlacement {
  readonly nodeId: string;
  readonly parentNodeId: string | null;
  readonly sequence: number;
  readonly presentation: "public" | "opaque";
}

export interface PublicMessageActivityNode extends PublicActivityPlacement {
  readonly kind: "message";
  readonly state: "streaming" | "done";
  readonly publicData: {
    readonly kind: "message";
    readonly messageId: string;
    readonly role: "user" | "assistant" | "system";
  };
}

export interface PublicToolActivityData {
  readonly kind: "tool-call";
  readonly callId: string;
  readonly name: string;
  readonly rawInput?: string;
  readonly input?: Json;
  readonly output?: Json;
  readonly errorText?: string;
}

export interface PublicToolActivityNode extends PublicActivityPlacement {
  readonly kind: "tool-call";
  readonly state: "input-streaming" | "input-available" | "output-available" | "output-error";
  readonly publicData: PublicToolActivityData;
}

export interface PublicGenericActivityNode extends PublicActivityPlacement {
  readonly kind: "activity";
  readonly state: "running" | "complete" | "error" | "cancelled";
  readonly publicData?: {
    readonly kind: "activity";
    readonly activityType: string;
    readonly data?: Json;
  };
}

export interface PublicElicitActivityData {
  readonly kind: "elicit";
  readonly elicitId: string;
  readonly bindingId: string;
  readonly key: string;
  readonly message: string;
  readonly context?: Json;
  readonly responseContract: PortableSchemaDescriptor;
  readonly contextContract?: PortableSchemaDescriptor;
  readonly toolName: string;
  readonly callId: string;
  readonly producerSequence: number;
}

export interface PublicElicitActivityNode extends PublicActivityPlacement {
  readonly kind: "elicit";
  readonly state: "pending" | "responded" | "cancelled";
  readonly publicData: PublicElicitActivityData;
}

/** A parsed public node is legal by construction: each kind owns its states and data. */
export type PublicActivityNode =
  | PublicMessageActivityNode
  | PublicToolActivityNode
  | PublicGenericActivityNode
  | PublicElicitActivityNode;

export type PublicActivityData = NonNullable<PublicActivityNode["publicData"]>;

export interface SweatpantsPublicActivity {
  readonly version: 1;
  readonly node: PublicActivityNode;
}
