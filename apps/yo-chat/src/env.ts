import { appEnv } from './env.schema'
import { env as publicEnv } from '@tanstack/start-env'
import type { AppEnv } from './env.schema'

const isServer = typeof window === 'undefined'

/**
 * Unified app env, Cloudflare-style:
 *
 *   import { env } from '@/env'
 *
 * - On the server: fully-typed, validated result from @t3-oss/env-core.
 * - On the client: hydrated public env from @tanstack/start-env (VITE_* only).
 */
export const env: AppEnv = isServer
  ? appEnv
  : ({
      // client: only VITE_* keys, validated and injected at runtime
      ...publicEnv,
    } as Partial<AppEnv> as AppEnv)
