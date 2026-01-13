import { mathAssistant } from './math-assistant.ts'
import { general } from './general.ts'
import type {
  PersonaDefinition,
  ResolvedPersona,
  PersonaConfig,
  EffortLevel,
} from './types.ts'

export * from './types.ts'
export { definePersona } from './types.ts'

// Persona registry
export const personas = {
  general: general,
  'math-assistant': mathAssistant,
} as const

export type PersonaName = keyof typeof personas

// Resolve persona with client config
export function resolvePersona(
  name: PersonaName,
  clientConfig?: PersonaConfig,
  enableOptionalTools?: string[],
  effort?: EffortLevel
): ResolvedPersona {
  const persona = personas[name]
  if (!persona) throw new Error(`Unknown persona: ${name}`)

  const config = resolveConfig(persona, clientConfig)
  const systemPrompt =
    typeof persona.systemPrompt === 'function'
      ? persona.systemPrompt({ config })
      : persona.systemPrompt
  const tools = resolveTools(persona, enableOptionalTools)

  // Resolve model based on effort
  const effortLevel =
    effort === 'auto' || !effort
      ? persona.defaultEffort ?? 'medium'
      : effort

  const model = persona.effortLevels?.[effortLevel]?.models

  return {
    name,
    systemPrompt,
    tools,
    ...(model ? { model } : {}),
    capabilities: {
      thinking: persona.requires?.thinking ?? false,
      streaming: persona.requires?.streaming ?? true,
      tools,
    },
  }
}

// Helper: resolve config with defaults + validation
function resolveConfig(
  persona: PersonaDefinition,
  clientConfig?: PersonaConfig
): PersonaConfig {
  const config: PersonaConfig = {}

  if (persona.configurable) {
    for (const [key, schema] of Object.entries(persona.configurable)) {
      const clientValue = clientConfig?.[key]

      if (clientValue !== undefined) {
        // Validate type matches
        if (typeof clientValue !== schema.type) {
          throw new Error(`Invalid config: ${key} must be ${schema.type}`)
        }
        // Validate number bounds
        if (schema.type === 'number') {
          if (
            schema.min !== undefined &&
            (clientValue as number) < schema.min
          ) {
            throw new Error(`Invalid config: ${key} must be >= ${schema.min}`)
          }
          if (
            schema.max !== undefined &&
            (clientValue as number) > schema.max
          ) {
            throw new Error(`Invalid config: ${key} must be <= ${schema.max}`)
          }
        }
        // Validate string options
        if (
          schema.type === 'string' &&
          schema.options &&
          !schema.options.includes(clientValue as string)
        ) {
          throw new Error(
            `Invalid config: ${key} must be one of ${schema.options.join(', ')}`
          )
        }
        config[key] = clientValue
      } else {
        config[key] = schema.default
      }
    }
  }

  return config
}

// Helper: resolve tools with optional tool validation
function resolveTools(
  persona: PersonaDefinition,
  enableOptionalTools?: string[]
): string[] {
  const tools = [...persona.requiredTools]

  if (enableOptionalTools?.length) {
    for (const tool of enableOptionalTools) {
      if (!persona.optionalTools?.includes(tool)) {
        throw new Error(
          `Tool "${tool}" is not optional for persona "${persona.name}"`
        )
      }
      tools.push(tool)
    }
  }

  return tools
}

// Get manifest for /api/chat/personas endpoint (safe for client)
export function getPersonaManifest() {
  return Object.fromEntries(
    Object.entries(personas).map(([name, p]) => [
      name,
      {
        description: p.description,
        requiredTools: p.requiredTools,
        optionalTools: p.optionalTools ?? [],
        configurable: p.configurable
          ? Object.fromEntries(
              Object.entries(p.configurable).map(([k, v]) => [
                k,
                { type: v.type, default: v.default },
              ])
            )
          : {},
        effortLevels: p.effortLevels ? Object.keys(p.effortLevels) : [],
        defaultEffort: p.defaultEffort,
        requires: p.requires ?? {},
      },
    ])
  )
}
