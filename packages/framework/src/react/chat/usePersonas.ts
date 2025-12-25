import { useState, useEffect } from 'react'
import { useChatConfig } from './ChatProvider'

// Client-side view of persona (no system prompts)
export interface PersonaInfo {
  description: string
  requiredTools: string[]
  optionalTools: string[]
  configurable: Record<string, { type: string; default: unknown }>
  effortLevels: string[]
  defaultEffort?: string
  requires: {
    thinking?: boolean
    streaming?: boolean
  }
}

export type PersonaManifest = Record<string, PersonaInfo>

interface UsePersonasOptions {
  /**
   * Base URL for the chat API.
   * 
   * Overrides the value from ChatProvider context.
   * The personas endpoint will be fetched from `${baseUrl}/personas`.
   */
  baseUrl?: string
}

interface UsePersonasReturn {
  personas: PersonaManifest | null
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function usePersonas(options: UsePersonasOptions = {}): UsePersonasReturn {
  const config = useChatConfig()
  const [personas, setPersonas] = useState<PersonaManifest | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Use baseUrl from options if provided, otherwise from context
  const baseUrl = options.baseUrl ?? config.baseUrl

  const fetchPersonas = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch(`${baseUrl}/personas`)
      if (!response.ok) {
        throw new Error(`Failed to fetch personas: ${response.status}`)
      }
      const data = await response.json()
      setPersonas(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchPersonas()
  }, [baseUrl])

  return {
    personas,
    isLoading,
    error,
    refresh: fetchPersonas,
  }
}
