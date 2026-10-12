import { useState } from "react";
import { makePlugin, type ReactRenderableProps } from "@sweatpants/react-chat";
import { Badge, Button, Card, Stack, TextInput } from "../design-system/primitives.tsx";
import { ask } from "../workflow/tools/ask.ts";
import { ReplyOutcome, type Reply } from "./reply.tsx";

export function ReplyForm({
  prompt,
  onRespond,
  disabled,
  response,
}: ReactRenderableProps<Reply> & { prompt: string }) {
  const [reply, setReply] = useState("");
  return (
    <Card.Root className="reply" tone="warning" padding={4}>
      <Stack gap={3}>
        <Stack direction="horizontal" gap={2} align="center" wrap>
          <Badge tone="warning">Input needed</Badge>
          <strong>{prompt}</strong>
        </Stack>
        {response ? (
          <ReplyOutcome response={response} />
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onRespond({ action: "accept", content: { reply } });
            }}
          >
            <Stack gap={3}>
              <TextInput
                label="Your reply"
                value={reply}
                disabled={disabled}
                onValueChange={setReply}
              />
              <Stack direction="horizontal" gap={2} wrap>
                <Button type="submit" disabled={disabled}>
                  Reply
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  color="secondary"
                  disabled={disabled}
                  onClick={() => onRespond({ action: "decline" })}
                >
                  Decline
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => onRespond({ action: "cancel" })}
                >
                  Cancel
                </Button>
              </Stack>
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
      return yield* context.render(ReplyForm, { prompt: input.context.prompt });
    },
  })
  .build();
