import { createFileRoute } from '@tanstack/react-router'
import { handleThreadMetadataRequest } from '@/lib/thread-metadata-api'

export const Route = createFileRoute('/api/threaded-chat/threads/')({
  server: {
    handlers: {
      GET: async ({ request }) => handleThreadMetadataRequest(request),
      POST: async ({ request }) => handleThreadMetadataRequest(request),
    },
  },
})
