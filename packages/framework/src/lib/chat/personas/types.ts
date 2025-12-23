// --- Capabilities ---

/** What the resolved session actually supports */
export interface Capabilities {
  thinking: boolean
  streaming: boolean
  tools: string[]
}

// --- Configuration ---

export type ConfigOption =
  | { type: 'boolean'; default: boolean }
  | { type: 'number'; default: number; min?: number; max?: number }
  | { type: 'string'; default: string; options?: string[] }

export type PersonaConfig = Record<string, boolean | number | string>

// --- Effort Levels ---

export type EffortLevel = 'auto' | 'low' | 'medium' | 'high'

export interface EffortConfig {
  models?: {
    ollama?: string
    openai?: string
  }
  // Future: reasoning_effort, temperature, etc.
}

// --- Persona Definition ---

export interface PersonaDefinition<
  TConfig extends Record<string, ConfigOption> = Record<string, ConfigOption>
> {
  name: string
  description: string

  /** System prompt - can be static string or dynamic function */
  systemPrompt: string | ((ctx: { config: PersonaConfig }) => string)

  /** Effort configurations */
  effortLevels?: Partial<Record<EffortLevel, EffortConfig>>
  defaultEffort?: EffortLevel

  /** Tools */
  requiredTools: string[]
  optionalTools?: string[]

  /** Client-configurable options */
  configurable?: TConfig

  /** Required capabilities */
  requires?: {
    thinking?: boolean
    streaming?: boolean
  }
}

// --- Resolved Persona ---

export interface ResolvedPersona {
  name: string
  systemPrompt: string
  tools: string[]
  model?: { ollama?: string; openai?: string }
  capabilities: Capabilities
}

// --- Helper ---

export function definePersona<T extends Record<string, ConfigOption>>(
  definition: PersonaDefinition<T>
): PersonaDefinition<T> {
  return definition
}
