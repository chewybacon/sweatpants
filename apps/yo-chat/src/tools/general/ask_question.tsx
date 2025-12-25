import { createIsomorphicTool } from '@tanstack/framework/chat/isomorphic-tools'
import { z } from 'zod'

export const askQuestion = createIsomorphicTool('ask_question')
  .description('Ask a question to the user')
  .parameters(
    z.object({
      question: z.string().describe('Question to ask the user'),
    })
  )
  .authority("server")
  .handoff({
    *before(params, ctx) {
      return params
    },
    *client(handoff, ctx, params) {
      return params
    },
    *after(handoff, client, ctx, params) {
    }
  })

