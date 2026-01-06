import { createIsomorphicTool } from '@sweatpants/framework/chat/isomorphic-tools'
import { z } from 'zod'

export const askQuestion = createIsomorphicTool('ask_question')
  .description('Ask a question to the user')
  .parameters(
    z.object({
      question: z.string().describe('Question to ask the user'),
    })
  )
  .context('browser')
  .authority('server')
  .handoff({
    *before(params) {
      return params
    },
    *client(handoff) {
      return handoff
    },
    *after(handoff, client) {
      return { question: handoff.question, answer: client.question }
    },
  })

