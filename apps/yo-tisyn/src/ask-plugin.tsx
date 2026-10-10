import { useState } from "react";
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
    <section className="reply">
      <strong>{prompt}</strong>
      {response ? (
        <ReplyOutcome response={response} />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onRespond({ action: "accept", content: { reply } });
          }}
        >
          <label>
            Your reply
            <input
              value={reply}
              maxLength={4096}
              disabled={disabled}
              onChange={(event) => setReply(event.target.value)}
            />
          </label>
          <button disabled={disabled} type="submit">
            Reply
          </button>
          <button
            disabled={disabled}
            type="button"
            onClick={() => onRespond({ action: "decline" })}
          >
            Decline
          </button>
          <button disabled={disabled} type="button" onClick={() => onRespond({ action: "cancel" })}>
            Cancel
          </button>
        </form>
      )}
    </section>
  );
}
export const askPlugin = makePlugin(ask)
  .onElicit({
    reply: function* (input, context) {
      return yield* context.render(ReplyForm, { prompt: input.context.prompt });
    },
  })
  .build();
