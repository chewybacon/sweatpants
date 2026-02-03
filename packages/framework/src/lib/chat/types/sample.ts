/**
 * Semantic types for LLM sampling operations.
 *
 * These types define the structure of sample request payloads and response content.
 * The core transport treats these as opaque `unknown`, but the framework interprets them.
 *
 * @packageDocumentation
 */

import { z } from "zod";

// ============================================================================
// Message Types
// ============================================================================

/**
 * Role of a message in a conversation.
 */
export const MessageRoleSchema = z.enum(["user", "assistant", "system"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/**
 * Simple text content block.
 */
export const TextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export type TextContent = z.infer<typeof TextContentSchema>;

/**
 * Tool use content block - assistant requesting to call a tool.
 */
export const ToolUseContentSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});
export type ToolUseContent = z.infer<typeof ToolUseContentSchema>;

/**
 * Tool result content block - providing tool output back.
 */
export const ToolResultContentSchema = z.object({
  type: z.literal("tool_result"),
  toolUseId: z.string(),
  content: z.array(TextContentSchema),
  isError: z.boolean().optional(),
});
export type ToolResultContent = z.infer<typeof ToolResultContentSchema>;

/**
 * Union of all content block types.
 */
export const ContentBlockSchema = z.discriminatedUnion("type", [
  TextContentSchema,
  ToolUseContentSchema,
  ToolResultContentSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/**
 * A message in an LLM conversation.
 * Content can be a simple string or an array of content blocks.
 */
export const SampleMessageSchema = z.object({
  role: MessageRoleSchema,
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
});
export type SampleMessage = z.infer<typeof SampleMessageSchema>;

// ============================================================================
// Model Configuration
// ============================================================================

/**
 * Model preferences for sampling.
 */
export const ModelPreferencesSchema = z.object({
  hints: z.array(z.object({ name: z.string().optional() })).optional(),
  costPriority: z.number().optional(),
  speedPriority: z.number().optional(),
  intelligencePriority: z.number().optional(),
});
export type ModelPreferences = z.infer<typeof ModelPreferencesSchema>;

/**
 * Tool definition for LLM tool calling.
 */
export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

/**
 * How the model should choose tools.
 */
export const ToolChoiceSchema = z.union([
  z.literal("auto"),
  z.literal("none"),
  z.literal("required"),
  z.object({ type: z.literal("tool"), name: z.string() }),
]);
export type ToolChoice = z.infer<typeof ToolChoiceSchema>;

/**
 * A tool call made by the model.
 */
export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

// ============================================================================
// Sample Request Payload
// ============================================================================

/**
 * Sample request payload - sent as TransportRequest.payload when kind="sample".
 * This is the semantic interpretation of the opaque payload at the framework level.
 */
export const SamplePayloadSchema = z.object({
  messages: z.array(SampleMessageSchema),
  systemPrompt: z.string().optional(),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  stop: z.array(z.string()).optional(),
  model: z.string().optional(),
  modelPreferences: ModelPreferencesSchema.optional(),
  tools: z.array(ToolDefinitionSchema).optional(),
  toolChoice: ToolChoiceSchema.optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
});
export type SamplePayload = z.infer<typeof SamplePayloadSchema>;

// ============================================================================
// Sample Response Content
// ============================================================================

/**
 * Sample response content - returned as SampleResponse.content when status="accepted".
 * This is the semantic interpretation of the opaque content at the framework level.
 *
 * Note: `parsed` and `parseError` are mutually exclusive - if structured output was
 * requested via schema, either parsing succeeded (parsed is set) or failed (parseError is set).
 */
export const SampleContentSchema = z
  .object({
    text: z.string(),
    model: z.string().optional(),
    stopReason: z.string().optional(),
    usage: z
      .object({
        promptTokens: z.number(),
        completionTokens: z.number(),
        totalTokens: z.number(),
      })
      .optional(),
    parsed: z.unknown().optional(),
    parseError: z
      .object({
        message: z.string(),
        rawText: z.string(),
      })
      .optional(),
    toolCalls: z.array(ToolCallSchema).optional(),
  })
  .refine((v) => !(v.parsed !== undefined && v.parseError !== undefined), {
    message: "parsed and parseError are mutually exclusive",
  });
export type SampleContent = z.infer<typeof SampleContentSchema>;

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Parse and validate sample payload data.
 * Throws ZodError if validation fails.
 */
export function parseSamplePayload(data: unknown): SamplePayload {
  return SamplePayloadSchema.parse(data);
}

/**
 * Parse and validate sample content data.
 * Throws ZodError if validation fails.
 */
export function parseSampleContent(data: unknown): SampleContent {
  return SampleContentSchema.parse(data);
}

/**
 * Safely parse sample payload data.
 * Returns a result object with success flag.
 */
export function safeParseSamplePayload(data: unknown) {
  return SamplePayloadSchema.safeParse(data);
}

/**
 * Safely parse sample content data.
 * Returns a result object with success flag.
 */
export function safeParseSampleContent(data: unknown) {
  return SampleContentSchema.safeParse(data);
}
