import type { Pool, PoolClient } from 'pg'

import type { PostgresStoreAdapter } from './postgres-store.ts'

export interface PgAdapterConfig {
  pool: Pool
  listener?: PoolClient
  tableName?: string
  channelPrefix?: string
  waitTimeoutMs?: number
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/**
 * Concrete Postgres key/value adapter for durable-stream stores.
 *
 * Uses a single table with (key, value, updated_at) and optional LISTEN/NOTIFY.
 */
export function createPgStoreAdapter(config: PgAdapterConfig): PostgresStoreAdapter {
  const {
    pool,
    listener,
    tableName = 'durable_streams_kv',
    channelPrefix = 'durable_streams',
    waitTimeoutMs = 30_000,
  } = config

  const tableRef = quoteIdentifier(tableName)
  let initPromise: Promise<void> | null = null

  const ensureSchema = async () => {
    if (!initPromise) {
      initPromise = pool
        .query(
          `
          CREATE TABLE IF NOT EXISTS ${tableRef} (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `,
        )
        .then(() => undefined)
    }

    await initPromise
  }

  const channelFor = (channel: string) => `${channelPrefix}_${channel}`

  const adapter: PostgresStoreAdapter = {
    async get(key: string): Promise<string | null> {
      await ensureSchema()
      const result = await pool.query(
        `SELECT value FROM ${tableRef} WHERE key = $1`,
        [key],
      )
      return (result.rows[0]?.value as string | undefined) ?? null
    },

    async set(key: string, value: string): Promise<void> {
      await ensureSchema()
      await pool.query(
        `
        INSERT INTO ${tableRef} (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `,
        [key, value],
      )
    },

    async del(key: string): Promise<void> {
      await ensureSchema()
      await pool.query(`DELETE FROM ${tableRef} WHERE key = $1`, [key])
    },

    async notifyChange(channel: string): Promise<void> {
      const name = channelFor(channel)
      await pool.query(`SELECT pg_notify($1, 'change')`, [name])
    },
  }

  if (listener) {
    adapter.waitForChange = async (channel: string): Promise<void> => {
      const name = channelFor(channel)
      await listener.query(`LISTEN ${quoteIdentifier(name)}`)

      await new Promise<void>((resolve, reject) => {
        let settled = false
        let timeout: ReturnType<typeof setTimeout> | undefined

        const onNotification = (msg: { channel: string }) => {
          if (msg.channel !== name) {
            return
          }
          finish()
        }

        const finish = (error?: unknown) => {
          if (settled) {
            return
          }
          settled = true
          if (timeout) {
            clearTimeout(timeout)
          }
          listener.removeListener('notification', onNotification)
          void listener
            .query(`UNLISTEN ${quoteIdentifier(name)}`)
            .catch(() => {
              // ignore unlisten failures on disconnect/race
            })
            .finally(() => {
              if (error) {
                reject(error)
              } else {
                resolve()
              }
            })
        }

        timeout = setTimeout(() => finish(), waitTimeoutMs)
        listener.on('notification', onNotification)
      })
    }
  }

  return adapter
}
