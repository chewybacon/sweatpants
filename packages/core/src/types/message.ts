export type ElicitResponse =
  | { status: "accepted"; content: unknown }
  | { status: "declined" }
  | { status: "cancelled" }
  | { status: "denied" }
  | { status: "other"; content: string };

export type NotifyResponse = { ok: true } | { ok: false; error: Error };

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
