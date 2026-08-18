import type { ElicitExchangeCompletion, SampleExchangeCompletion } from "@sweatpants/agent-sdk";
import type { Json } from "@sweatpants/foundation";

export type ToolInvocationResume =
  | {
      readonly kind: "sample";
      readonly requestId: string;
      readonly response: SampleExchangeCompletion;
    }
  | {
      readonly kind: "elicit";
      readonly requestId: string;
      readonly response: ElicitExchangeCompletion<Json>;
    }
  | {
      readonly kind: "cancel";
      readonly reason?: string;
    };
