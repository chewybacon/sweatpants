import { appEnv } from './env.schema'
import type { AppEnv } from './env.schema'

const isServer = typeof window === 'undefined'

/**
 * Unified app env:
 *
 *   import { env } from '@/env'
 *
 * - On the server: fully-typed, validated result from @t3-oss/env-core.
 * - On the client: only VITE_* keys are available via import.meta.env.
 */
export const env: AppEnv = isServer
  ? appEnv
  : ({
      // client: only VITE_* keys from import.meta.env
      VITE_BASE_PATH: import.meta.env['VITE_BASE_PATH'] || '/',
    } as Partial<AppEnv> as AppEnv)
