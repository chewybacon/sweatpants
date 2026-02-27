import type { RedisClientType } from 'redis'

import type { RedisStoreAdapter } from './redis-store.ts'

export interface NodeRedisAdapterConfig {
  client: RedisClientType
  subscriber?: RedisClientType
  waitTimeoutMs?: number
}

/**
 * Concrete Redis adapter backed by node-redis clients.
 *
 * - `client` is used for get/set/del/publish
 * - `subscriber` is used for blocking waitForChange via pub/sub
 */
export function createNodeRedisStoreAdapter(
  config: NodeRedisAdapterConfig,
): RedisStoreAdapter {
  const { client, subscriber, waitTimeoutMs = 30_000 } = config

  const adapter: RedisStoreAdapter = {
    async get(key: string): Promise<string | null> {
      return await client.get(key)
    },

    async set(key: string, value: string): Promise<void> {
      await client.set(key, value)
    },

    async del(key: string): Promise<void> {
      await client.del(key)
    },

    async publishChange(channel: string): Promise<void> {
      await client.publish(channel, 'change')
    },
  }

  if (subscriber) {
    adapter.waitForChange = async (channel: string): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        let timeout: ReturnType<typeof setTimeout> | undefined

        const cleanup = async () => {
          if (timeout) {
            clearTimeout(timeout)
          }

          try {
            await subscriber.unsubscribe(channel, onMessage)
          } catch {
            // ignore unsubscribe failures on shutdown/race
          }
        }

        const finish = (error?: unknown) => {
          if (settled) {
            return
          }
          settled = true
          void cleanup().finally(() => {
            if (error) {
              reject(error)
            } else {
              resolve()
            }
          })
        }

        const onMessage = () => {
          finish()
        }

        timeout = setTimeout(() => finish(), waitTimeoutMs)

        subscriber.subscribe(channel, onMessage).catch((error) => finish(error))
      })
    }
  }

  return adapter
}
