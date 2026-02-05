export type ElicitResponse =
  | { status: "accepted"; content: unknown }
  | { status: "declined" }
  | { status: "cancelled" }
  | { status: "denied" }
  | { status: "other"; content: string };

/**
 * Response for notify requests - acknowledgment that notification was received.
 * Error is serializable (not Error object) for transport safety.
 */
export type NotifyResponse =
  | { ok: true }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

/**
 * Response for sample requests - LLM completion results.
 * Content is opaque at transport level; framework interprets it.
 */
export type SampleResponse =
  | { status: "accepted"; content: unknown }
  | { status: "error"; error: string }
  | { status: "cancelled" };

export type Invocation = ElicitInvocation | NotifyInvocation;

export interface ElicitInvocation {
  kind: "elicit";
  type: string;
  request: unknown;
  response: ElicitResponse;
}

export interface NotifyInvocation {
  kind: "notify";
  type: string;
  payload: unknown;
  response: NotifyResponse;
}

export interface Message {
  id: string;
  parentId: string | null;
  role: "user" | "assistant";
  content: string;
  invocation?: Invocation;
  createdAt: number;
}

export interface Conversation {
  id: string;
  messages: Message[];
}
