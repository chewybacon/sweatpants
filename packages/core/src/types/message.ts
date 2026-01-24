/**
 * Data model types for conversations and messages.
 *
 * These types define what gets persisted. Effection manages the runtime state
 * (coroutine tree, middleware); this data model captures the conversation
 * for context and rewind.
 */

/**
 * Elicit returns user's choice - discriminated union of possible outcomes.
 */
export type ElicitResponse =
  | { status: "accepted"; content: unknown }
  | { status: "declined" }
  | { status: "cancelled" }
  | { status: "denied" } // permission denied (device APIs)
  | { status: "other"; content: string }; // user went off-script

/**
 * Notify returns acknowledgment - frontend finished rendering.
 */
export type NotifyResponse = { ok: true } | { ok: false; error: Error };

/**
 * Both elicit and notify invoke frontend methods. They go through the same
 * transport, both wait for completion (backpressure), but differ in response type.
 */
export type Invocation = ElicitInvocation | NotifyInvocation;

export interface ElicitInvocation {
  kind: "elicit";
  type: string; // e.g., 'location', 'flight-selection'
  request: unknown; // what was asked
  response: ElicitResponse; // user's response
}

export interface NotifyInvocation {
  kind: "notify";
  type: string; // e.g., 'progress', 'status', 'card-reveal'
  payload: unknown; // what was shown
  response: NotifyResponse; // acknowledgment
}

/**
 * The fundamental unit of a conversation.
 */
export interface Message {
  id: string;
  parentId: string | null;

  role: "user" | "assistant";
  content: string;

  /**
   * If this message involved a frontend invocation
   */
  invocation?: Invocation;

  createdAt: number;
}

/**
 * A conversation is an append-only list of messages.
 *
 * Key properties:
 * - Tree structure is implicit: parentId relationships form the tree.
 *   Branches occur when two messages share the same parentId.
 * - Append-only: Messages are never deleted. Discarded branches (from
 *   rewind/edit) remain in the array, just not in the current path.
 * - Progress is ephemeral: Progress events during an elicit are not
 *   persisted - only the final response.
 */
export interface Conversation {
  id: string;
  messages: Message[]; // append-only
}
