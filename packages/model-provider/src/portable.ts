import type { Json, JsonObject } from "@sweatpants/foundation";

/** JSON-safe settled call retained across durable model-sampling boundaries. */
export type PortableToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    /** Open until the authored tool schema executes. */
    arguments: Json;
  };
  thoughtSignature?: string;
} & JsonObject;

export type PortableModelInputBlock =
  | ({ type: "text"; text: string; textSignature?: string } & JsonObject)
  | ({ type: "image"; data: string; mimeType: string } & JsonObject);

export type PortableModelAssistantBlock =
  | PortableModelInputBlock
  | ({
      type: "thinking";
      text: string;
      format?: string;
      thinkingSignature?: string;
      redacted?: boolean;
    } & JsonObject)
  | ({ type: "toolCall"; toolCall: PortableToolCall } & JsonObject);

/** Closed settled context accepted by every model-provider adapter. */
export type PortableModelContextMessage =
  | ({ role: "system"; content: string } & JsonObject)
  | ({ role: "user"; content: string | PortableModelInputBlock[] } & JsonObject)
  | ({ role: "assistant"; content: PortableModelAssistantBlock[] } & JsonObject)
  | ({
      role: "tool";
      tool_call_id: string;
      name: string;
      content: string | PortableModelInputBlock[];
      isError: boolean;
    } & JsonObject);

export type PortableModelTool = {
  name: string;
  description?: string;
  /** Retained authored portable projection. */
  parameters: JsonObject;
} & JsonObject;

export type PortableModelContext = {
  systemPrompt?: string;
  messages: PortableModelContextMessage[];
  tools?: PortableModelTool[];
} & JsonObject;

export type PortableGenerationOptions = {
  toolChoice?: "auto" | "none" | "required";
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  responseFormat?: { type: "json_schema"; name?: string; schema: JsonObject };
} & JsonObject;

export type PortableModelInvocation = {
  context: PortableModelContext;
  options?: PortableGenerationOptions;
} & JsonObject;

export type PortableModelResponseSource = {
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
} & JsonObject;

export type PortableAssistantMessage = {
  role: "assistant";
  content: PortableModelAssistantBlock[];
  source?: PortableModelResponseSource;
  stopReason?: string;
  responseId?: string;
  errorMessage?: string;
} & JsonObject;
