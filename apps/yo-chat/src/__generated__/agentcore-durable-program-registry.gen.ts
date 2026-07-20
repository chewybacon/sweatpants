/**
 * Exact AgentCore durable-program registry (auto-generated).
 *
 * DO NOT EDIT. This artifact intentionally imports no ordinary ToolSession tool.
 */
import { pickCard } from '../tools/pick-card/durable'
import { playTttTool } from '../tools/play-ttt/tool'

export const agentCoreDurableDefinitions = {
  'pick_card': pickCard,
  'play_ttt': playTttTool,
} as const

export const agentCoreDurablePrograms = new Map(
  Object.values(agentCoreDurableDefinitions).map((tool) => [
    `${tool.manifest.programId}@${tool.manifest.version}#${tool.manifest.digest}`,
    tool,
  ] as const)
)

export const agentCoreDurableProgramCatalog = Object.values(agentCoreDurableDefinitions).map((tool) => ({
  publicName: tool.name,
  program: {
    id: tool.manifest.programId,
    version: tool.manifest.version,
    digest: tool.manifest.digest,
  },
}))
