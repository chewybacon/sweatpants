export type Reply =
  | { action: "accept"; content: { reply: string } }
  | { action: "decline" }
  | { action: "cancel" };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringField(value: unknown, key: string): string | undefined {
  const field = object(value)?.[key];
  return typeof field === "string" ? field : undefined;
}

export function readReply(value: unknown): Reply | undefined {
  const data = object(value);
  if (data?.action === "decline" || data?.action === "cancel") {
    return { action: data.action };
  }
  const reply = stringField(data?.content, "reply");
  return data?.action === "accept" && reply !== undefined
    ? { action: "accept", content: { reply } }
    : undefined;
}

export function ReplyOutcome({ response }: { response: Reply }) {
  return response.action === "accept" ? (
    <div className="reply-outcome">
      <span className="field-label">You replied</span>
      <blockquote>{response.content.reply || "(empty reply)"}</blockquote>
    </div>
  ) : (
    <p className="reply-outcome">
      {response.action === "decline" ? "You declined this request." : "You cancelled this request."}
    </p>
  );
}
