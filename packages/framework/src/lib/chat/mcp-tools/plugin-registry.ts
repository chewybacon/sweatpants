/**
 * Plugin Registry
 *
 * Manages registration and lookup of MCP plugin client registrations.
 * Used by the chat engine to route elicitation requests to the appropriate plugin handlers.
 *
 * ## Usage
 *
 * ```typescript
 * // Create a registry
 * const registry = createPluginRegistry()
 *
 * // Register plugins
 * registry.register(bookFlightPlugin.client)
 * registry.register(weatherPlugin.client)
 *
 * // Lookup by tool name
 * const plugin = registry.get('book_flight')
 * if (plugin) {
 *   yield* executePluginElicitHandler(plugin, key, request, ctx)
 * }
 * ```
 */

import type { PluginClientRegistrationInput } from './plugin.ts'

// =============================================================================
// PLUGIN REGISTRY INTERFACE
// =============================================================================

/**
 * Registry for plugin client registrations.
 */
export interface PluginRegistry {
  /**
   * Register a plugin's client registration.
   *
   * @param plugin - The plugin client registration to register
   * @throws If a plugin with the same tool name is already registered
   */
  register(plugin: PluginClientRegistrationInput): void

  /**
   * Get a plugin by tool name.
   *
   * @param toolName - The tool name to look up
   * @returns The plugin registration, or undefined if not found
   */
  get(toolName: string): PluginClientRegistrationInput | undefined

  /**
   * Check if a plugin is registered for a tool name.
   *
   * @param toolName - The tool name to check
   * @returns True if a plugin is registered
   */
  has(toolName: string): boolean

  /**
   * Get all registered tool names.
   *
   * @returns Array of tool names
   */
  toolNames(): string[]

  /**
   * Get the number of registered plugins.
   */
  readonly size: number
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Create a new plugin registry.
 *
 * @returns A new PluginRegistry instance
 */
export function createPluginRegistry(): PluginRegistry {
  const plugins = new Map<string, PluginClientRegistrationInput>()

  return {
    register(plugin: PluginClientRegistrationInput): void {
      if (plugins.has(plugin.toolName)) {
        throw new Error(
          `Plugin for tool "${plugin.toolName}" is already registered. ` +
          `Each tool can only have one plugin registration.`
        )
      }
      plugins.set(plugin.toolName, plugin)
    },

    get(toolName: string): PluginClientRegistrationInput | undefined {
      return plugins.get(toolName)
    },

    has(toolName: string): boolean {
      return plugins.has(toolName)
    },

    toolNames(): string[] {
      return Array.from(plugins.keys())
    },

    get size(): number {
      return plugins.size
    },
  }
}

// =============================================================================
// CONVENIENCE FUNCTIONS
// =============================================================================

/**
 * Create a plugin registry from an array of plugins.
 *
 * @param plugins - Array of plugin client registrations
 * @returns A new PluginRegistry with all plugins registered
 * @throws If any plugins have duplicate tool names
 *
 * @example
 * ```typescript
 * const registry = createPluginRegistryFrom([
 *   bookFlightPlugin.client,
 *   weatherPlugin.client,
 * ])
 * ```
 */
export function createPluginRegistryFrom(
  plugins: PluginClientRegistrationInput[]
): PluginRegistry {
  const registry = createPluginRegistry()
  for (const plugin of plugins) {
    registry.register(plugin)
  }
  return registry
}
