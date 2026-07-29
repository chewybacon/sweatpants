import type { Json } from "@sweatpants/foundation";
import type { AgentCardSigner } from "./agent-card-signing.ts";

export interface PublicAgentDeployment {
  readonly interfaceUrl: string;
  readonly protocolBinding?: "HTTP+JSON" | "JSONRPC" | "GRPC";
  readonly securitySchemes?: Json;
  readonly securityRequirements?: Json[];
  readonly defaultInputModes?: readonly string[];
  readonly defaultOutputModes?: readonly string[];
  readonly insecureLoopbackDevelopment?: boolean;
  readonly unsafeAllowNonLoopbackHttp?: boolean;
  readonly cardSigner?: AgentCardSigner;
}
