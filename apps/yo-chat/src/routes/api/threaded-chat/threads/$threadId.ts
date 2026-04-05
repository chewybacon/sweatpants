import { createFileRoute } from '@tanstack/react-router'
import { handleThreadMetadataRequest } from '@/lib/thread-metadata-api'

export const Route = createFileRoute('/api/threaded-chat/threads/$threadId')({
  server: {
    handlers: {
      GET: async ({ request }) => handleThreadMetadataRequest(request),
      PUT: async ({ request }) => handleThreadMetadataRequest(request),
      PATCH: async ({ request }) => handleThreadMetadataRequest(request),
      DELETE: async ({ request }) => handleThreadMetadataRequest(request),
    },
  },
})
