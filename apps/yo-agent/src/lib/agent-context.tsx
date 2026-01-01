/**
 * Agent Context
 *
 * React context to provide the dev server handle to components.
 * Bridges the Effection world to React.
 */
import React, { createContext, useContext } from 'react'
import type { DevServerHandle } from './dev-server.ts'
import type { AgentMode } from '../components/App.tsx'

export interface AgentContextValue {
  /** The dev server handle for making requests */
  devServer: DevServerHandle | null

  /** Current agent mode */
  mode: AgentMode

  /** Whether the dev server is ready */
  isReady: boolean

  /** Last HMR event (for UI feedback) */
  lastHmrEvent: { type: string; file: string; timestamp: number } | null
}

const AgentContext = createContext<AgentContextValue | null>(null)

export interface AgentProviderProps {
  value: AgentContextValue
  children: React.ReactNode
}

export function AgentProvider({ value, children }: AgentProviderProps) {
  return (
    <AgentContext.Provider value={value}>
      {children}
    </AgentContext.Provider>
  )
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext)
  if (!ctx) {
    throw new Error('useAgent must be used within AgentProvider')
  }
  return ctx
}
