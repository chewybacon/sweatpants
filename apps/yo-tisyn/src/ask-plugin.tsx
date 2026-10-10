import { useState } from "react";
import { Badge, Button, Card, HStack, TextInput, VStack } from "@astryxdesign/core";
import { makePlugin, type ReactRenderableProps } from "@sweatpants/react-chat";
import { ask } from "./tools/ask.ts";
import { ReplyOutcome, type Reply } from "./reply.tsx";

export function ReplyForm({
  prompt,
  onRespond,
  disabled,
  response,
}: ReactRenderableProps<Reply> & { prompt: string }) {
  const [reply, setReply] = useState("");
  return (
    <Card className="reply" variant="yellow" padding={4}>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center">
          <Badge label="INPUT NEEDED" variant="warning" />
          <strong>{prompt}</strong>
        </HStack>
        {response ? (
          <ReplyOutcome response={response} />
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onRespond({ action: "accept", content: { reply } });
            }}
          >
            <VStack gap={2}>
              <TextInput
                label="Your reply"
                value={reply}
                isDisabled={disabled}
                onChange={setReply}
              />
              <HStack gap={2} wrap="wrap">
                <Button label="Reply" type="submit" variant="primary" isDisabled={disabled} />
                <Button
                  label="Decline"
                  type="button"
                  variant="secondary"
                  isDisabled={disabled}
                  onClick={() => onRespond({ action: "decline" })}
                />
                <Button
                  label="Cancel"
                  type="button"
                  variant="ghost"
                  isDisabled={disabled}
                  onClick={() => onRespond({ action: "cancel" })}
                />
              </HStack>
            </VStack>
          </form>
        )}
      </VStack>
    </Card>
  );
}

export const askPlugin = makePlugin(ask)
  .onElicit({
    reply: function* (input, context) {
      return yield* context.render(ReplyForm, { prompt: input.context.prompt });
    },
  })
  .build();
