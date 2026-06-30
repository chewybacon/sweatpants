import { createTool } from '@sweatpants/core'
import { getElicitContext, makePlugin, stripMessageContext } from '@sweatpants/framework/chat'
import type { RenderableProps } from '@sweatpants/framework/chat/browser-rendering'
import { useState } from 'react'
import { z } from 'zod'

interface QuestionPromptProps extends RenderableProps<{ answer: string }> {
  question: string
}

function QuestionPrompt({ question, onRespond, disabled, response }: QuestionPromptProps) {
  const [answer, setAnswer] = useState('')

  if (disabled && response) {
    return (
      <div className="my-2 rounded-lg bg-muted p-3">
        <p className="mb-2 text-sm text-muted-foreground">{question}</p>
        <p className="text-sm">{response.answer}</p>
      </div>
    )
  }

  return (
    <form
      className="my-2 rounded-lg bg-muted p-3"
      onSubmit={(event) => {
        event.preventDefault()
        onRespond({ answer })
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
  )
}

QuestionPrompt.displayName = 'QuestionPrompt'

type AskQuestionContext = {
  question: string
  [key: string]: unknown
}

export const askQuestion = createTool('ask_question')
  .description('Ask a question to the user')
  .parameters(
    z.object({
      question: z.string().describe('Question to ask the user'),
    })
  )
  .elicits({
    askQuestion: {
      context: z.object({ question: z.string() }),
      response: z.object({ answer: z.string() }),
    },
  })
  .execute(function* (params, ctx) {
    const result = yield* ctx.elicit('askQuestion', {
      message: params.question,
      context: { question: params.question },
    })

    if (result.action !== 'accept') {
      return { question: params.question, answer: null, cancelled: true }
    }

    return { question: params.question, answer: result.content.answer }
  })

export const askQuestionPlugin = makePlugin(askQuestion)
  .onElicit({
    askQuestion: function* (req, ctx) {
      const context = getElicitContext<AskQuestionContext>(req)
      const question = context.question ?? stripMessageContext(req.message)
      const result = yield* ctx.render(QuestionPrompt, { question })
      return { action: 'accept' as const, content: result }
    },
  })
  .build()
