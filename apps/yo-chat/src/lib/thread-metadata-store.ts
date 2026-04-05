import type { ThreadSummary } from '@/lib/threaded-chat-types'

export interface CreateThreadMetadataInput {
  id?: string
  title?: string
  lastMessagePreview?: string
  messageCount?: number
}

export interface UpdateThreadMetadataInput {
  title?: string
  lastMessagePreview?: string
  messageCount?: number
}

export interface ThreadMetadataStore {
  list(): ThreadSummary[]
  get(threadId: string): ThreadSummary | null
  create(input?: CreateThreadMetadataInput): ThreadSummary
  update(threadId: string, input: UpdateThreadMetadataInput): ThreadSummary | null
  delete(threadId: string): boolean
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function normalizeTitle(title: string | undefined): string {
  const value = compact(title ?? '') || 'New thread'
  return value.length > 40 ? `${value.slice(0, 37)}...` : value
}

function normalizePreview(preview: string | undefined): string {
  const value = compact(preview ?? '') || 'No messages yet'
  return value.length > 80 ? `${value.slice(0, 77)}...` : value
}

function normalizeMessageCount(messageCount: number | undefined): number {
  if (typeof messageCount !== 'number' || Number.isNaN(messageCount) || messageCount < 0) {
    return 0
  }

  return Math.floor(messageCount)
}

export function createThreadSummary(
  input: CreateThreadMetadataInput = {},
  now: number = Date.now(),
): ThreadSummary {
  return {
    id: input.id ?? crypto.randomUUID(),
    title: normalizeTitle(input.title),
    createdAt: now,
    updatedAt: now,
    lastMessagePreview: normalizePreview(input.lastMessagePreview),
    messageCount: normalizeMessageCount(input.messageCount),
  }
}

export function createInMemoryThreadMetadataStore(): ThreadMetadataStore {
  const threads = new Map<string, ThreadSummary>()

  return {
    list() {
      return Array.from(threads.values()).sort((left, right) => right.updatedAt - left.updatedAt)
    },

    get(threadId) {
      return threads.get(threadId) ?? null
    },

    create(input = {}) {
      const thread = createThreadSummary(input)
      threads.set(thread.id, thread)
      return thread
    },

    update(threadId, input) {
      const existing = threads.get(threadId)
      if (!existing) {
        return null
      }

      const updatedAt = Date.now()
      const next: ThreadSummary = {
        ...existing,
        title: input.title !== undefined ? normalizeTitle(input.title) : existing.title,
        lastMessagePreview:
          input.lastMessagePreview !== undefined
            ? normalizePreview(input.lastMessagePreview)
            : existing.lastMessagePreview,
        messageCount:
          input.messageCount !== undefined
            ? normalizeMessageCount(input.messageCount)
            : existing.messageCount,
        updatedAt,
      }

      threads.set(threadId, next)
      return next
    },

    delete(threadId) {
      return threads.delete(threadId)
    },
  }
}

const sharedThreadMetadataStore = createInMemoryThreadMetadataStore()

export function getThreadMetadataStore(): ThreadMetadataStore {
  return sharedThreadMetadataStore
}
