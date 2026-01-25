import { z } from "zod";

// ============================================================================
// Response Schemas
// ============================================================================

export const ElicitResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), content: z.unknown() }).strict(),
  z.object({ status: z.literal("declined") }).strict(),
  z.object({ status: z.literal("cancelled") }).strict(),
  z.object({ status: z.literal("denied") }).strict(),
  z.object({ status: z.literal("other"), content: z.string() }).strict(),
]);

export const NotifyResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), error: z.instanceof(Error) }).strict(),
]);

// ============================================================================
// Transport Request Schema (Principal → Operative)
// ============================================================================

export const TransportRequestSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["elicit", "notify"]),
    type: z.string(),
    payload: z.unknown(),
  })
  .strict();

// ============================================================================
// Wire Message Schemas (for SSE/WebSocket)
// ============================================================================

/** Message sent from operative to principal: progress update */
export const ProgressMessageSchema = z
  .object({
    type: z.literal("progress"),
    id: z.string(),
    data: z.unknown(),
  })
  .strict();

/** Message sent from operative to principal: final response */
export const ResponseMessageSchema = z
  .object({
    type: z.literal("response"),
    id: z.string(),
    response: z.union([ElicitResponseSchema, NotifyResponseSchema]),
  })
  .strict();

/** Message sent from principal to operative: request */
export const RequestMessageSchema = z
  .object({
    type: z.literal("request"),
    payload: TransportRequestSchema,
  })
  .strict();

/** All wire messages that can be sent over WebSocket */
export const WebSocketMessageSchema = z.discriminatedUnion("type", [
  RequestMessageSchema,
  ProgressMessageSchema,
  ResponseMessageSchema,
]);

/** Incoming message on the operative side (from SSE stream) */
export const IncomingMessageDataSchema = TransportRequestSchema;

// ============================================================================
// Type Exports (inferred from schemas)
// ============================================================================

export type ElicitResponseParsed = z.infer<typeof ElicitResponseSchema>;
export type NotifyResponseParsed = z.infer<typeof NotifyResponseSchema>;
export type TransportRequestParsed = z.infer<typeof TransportRequestSchema>;
export type ProgressMessageParsed = z.infer<typeof ProgressMessageSchema>;
export type ResponseMessageParsed = z.infer<typeof ResponseMessageSchema>;
export type RequestMessageParsed = z.infer<typeof RequestMessageSchema>;
export type WebSocketMessageParsed = z.infer<typeof WebSocketMessageSchema>;
