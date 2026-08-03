import type { ReactRenderableProps } from "@sweatpants/react-chat";
import { useState } from "react";

export interface QuestionPromptProps extends ReactRenderableProps<{ answer: string }> {
  question: string;
}

export function QuestionPrompt({ question, onRespond, disabled, response }: QuestionPromptProps) {
  const [answer, setAnswer] = useState("");

  if (disabled && response) {
    return (
      <div className="my-2 rounded-lg bg-muted p-3">
        <p className="mb-2 text-sm text-muted-foreground">{question}</p>
        <p className="text-sm">{response.answer}</p>
      </div>
    );
  }

  return (
    <form
      className="my-2 rounded-lg bg-muted p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onRespond({ answer });
      }}
    >
      <p className="mb-2 text-sm text-muted-foreground">{question}</p>
      <div className="flex gap-2">
        <input
          className="min-w-0 flex-1 rounded border border-muted-foreground/30 bg-background px-2 py-1 text-sm"
          value={answer}
          onChange={(event) => setAnswer(event.currentTarget.value)}
          disabled={disabled}
          aria-label="Answer"
        />
        <button
          type="submit"
          disabled={disabled || answer.trim().length === 0}
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
        >
          Answer
        </button>
      </div>
    </form>
  );
}

QuestionPrompt.displayName = "QuestionPrompt";
