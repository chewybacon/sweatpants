import { createClient, type RedisClientType } from 'redis'
import { env } from '@/env'

let redisClient: RedisClientType | null = null
let redisInitialized = false

export async function getSharedRedisClient(): Promise<RedisClientType | null> {
  if (redisInitialized) {
    return redisClient
  }

  redisInitialized = true

  const redisUrl = env.REDIS_URL
  if (!redisUrl) {
    return null
  }

  try {
    redisClient = createClient({ url: redisUrl })
    await redisClient.connect()
    return redisClient
  } catch (error) {
    console.warn(
      '[redis] Failed to connect, falling back to in-memory:',
      (error as Error).message,
    )
    redisClient = null
    return null
  }
}
