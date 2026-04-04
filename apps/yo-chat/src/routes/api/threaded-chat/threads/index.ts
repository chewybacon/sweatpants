import { createFileRoute } from '@tanstack/react-router'
import { handleThreadedChatRequest } from '@/lib/threaded-chat-api'

export const Route = createFileRoute('/api/threaded-chat/threads/')({
  server: {
    handlers: {
      GET: async ({ request }) => handleThreadedChatRequest(request),
      POST: async ({ request }) => handleThreadedChatRequest(request),
    },
  },
})
