import { getElicitContext, makePlugin, stripMessageContext } from '@sweatpants/framework/chat'

import { QuestionPrompt } from './components/QuestionPrompt'
import { askQuestion } from './tool'

type AskQuestionContext = {
  question: string
  [key: string]: unknown
}

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
