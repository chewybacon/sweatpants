import { useContext, useId, useRef, useState } from "react";
import { makePlugin, type ReactRenderableProps } from "@sweatpants/react-chat";
import { Badge, Button, Card, Stack, TextArea } from "../design-system/primitives.tsx";
import { ask, replyLimit, type AskPresentation } from "../workflow/tools/ask.ts";
import { PendingToolReply, ReplyOutcome, type Reply } from "./reply.tsx";
import { useReplyFocus } from "./reply-focus.tsx";

export function ReplyForm({
  prompt,
  title,
  detail,
  placeholder,
  suggestions = [],
  onRespond,
  disabled,
  response,
}: ReactRenderableProps<Reply> & AskPresentation & { prompt: string }) {
  const pendingTool = useContext(PendingToolReply);
  const settling = !!response && pendingTool;
  const [reply, setReply] = useState("");
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const blocked = disabled || !!response;
  const followReply = useReplyFocus(input, blocked);
  const valid = reply.trim().length > 0 && reply.length <= replyLimit;
  function send() {
    if (!blocked && valid) {
      followReply();
      onRespond({ action: "accept", content: { reply } });
    }
  }
  return (
    <Card.Root className={`reply ask-card ${response ? "ask-settled" : "ask-pending"}`} padding={4}>
      <Stack gap={3}>
        <Stack direction="horizontal" gap={2} align="center" justify="between" wrap>
          <span className="ask-title">{title ?? "Over to you"}</span>
          <Badge tone={response ? "neutral" : "warning"}>
            {settling
              ? "Submitting…"
              : response
                ? response.action === "accept"
                  ? "Answered"
                  : response.action === "decline"
                    ? "Declined"
                    : "Cancelled"
                : disabled
                  ? "Waiting…"
                  : "Your turn"}
          </Badge>
        </Stack>
        <p className="ask-question" id={`${id}-question`}>
          {prompt}
        </p>
        {detail && <p className="ask-detail">{detail}</p>}
        {response && !settling ? (
          <ReplyOutcome response={response} />
        ) : (
          <form
            aria-labelledby={`${id}-question`}
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <Stack gap={3}>
              {suggestions.length > 0 && (
                <div className="ask-suggestions" aria-label="Suggested replies">
                  {[...new Set(suggestions)].map((suggestion) => (
                    <Button
                      key={suggestion}
                      type="button"
                      variant="outline"
                      disabled={blocked}
                      onClick={() => {
                        setReply(suggestion);
                        input.current?.focus();
                      }}
                    >
                      {suggestion}
                    </Button>
                  ))}
                </div>
              )}
              <TextArea
                ref={input}
                id={`${id}-reply`}
                label="Your reply"
                rows={3}
                value={response?.action === "accept" ? response.content.reply : reply}
                maxLength={replyLimit}
                placeholder={placeholder ?? "Answer, ask a question, or correct something…"}
                disabled={blocked}
                onValueChange={setReply}
                aria-describedby={`${id}-hint`}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey) &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
              <div className="ask-hint" id={`${id}-hint`}>
                <span>You can correct an earlier answer. Ctrl / ⌘ + Enter to send.</span>
                <span>
                  {reply.length.toLocaleString()} / {replyLimit.toLocaleString()}
                </span>
              </div>
              <div className="ask-actions">
                <Button type="submit" disabled={blocked || !valid}>
                  Reply
                </Button>
                <Stack direction="horizontal" gap={2} wrap>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={blocked}
                    onClick={() => {
                      if (!blocked) {
                        onRespond({ action: "decline" });
                      }
                    }}
                  >
                    Decline
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={blocked}
                    onClick={() => {
                      if (!blocked) {
                        onRespond({ action: "cancel" });
                      }
                    }}
                  >
                    Cancel
                  </Button>
                </Stack>
              </div>
            </Stack>
          </form>
        )}
      </Stack>
    </Card.Root>
  );
}

export const askPlugin = makePlugin(ask)
  .onElicit({
    reply: function* (input, context) {
      return yield* context.render(ReplyForm, input.context);
    },
  })
  .build();
