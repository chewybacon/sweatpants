/**
 * lib/chat/state/timeline.ts
 *
 * Timeline types for the unified chat timeline.
 * The timeline is the primary data structure for rendering chat UI.
 */

// =============================================================================
// TIMELINE ITEM TYPES
// =============================================================================

/**
 * User message in the timeline.
 */
export interface TimelineUserMessage {
  type: 'user'
  id: string
  content: string
  timestamp: number
}

/**
 * Assistant text in the timeline.
 */
export interface TimelineAssistantText {
  type: 'assistant_text'
  id: string
  content: string
  timestamp: number
}

/**
 * Thinking block in the timeline (model reasoning).
 */
export interface TimelineThinking {
  type: 'thinking'
  id: string
  content: string
  timestamp: number
}

/**
 * Tool call in the timeline.
 *
 * Steps are separate items with matching `callId`, not nested here.
 * This keeps the timeline flat for easy inline rendering.
 */
export interface TimelineToolCall {
  type: 'tool_call'
  id: string
  callId: string
  toolName: string
  input: unknown
  state: 'running' | 'complete' | 'error'
  output?: unknown
  error?: string
  timestamp: number
}

/**
 * Interactive step in the timeline.
 *
 * Steps are produced by tools using ctx.step() or ctx.render().
 * They appear inline in the timeline and can be pending (awaiting user input)
 * or complete.
 */
export interface TimelineStep {
  type: 'step'
  id: string
  /** Parent tool call ID */
  callId: string
  /** Step type for component lookup */
  stepType: string
  /** Serializable payload data */
  payload: unknown
  /** Current state */
  state: 'pending' | 'complete'
  /** Response once user completes the step */
  response?: unknown
  /**
   * React element for ctx.render() - TRANSIENT.
   * Present only for live steps from ctx.render().
   * Not serialized. For replay, use stepType + payload + component map.
   */
  element?: unknown
  /** Respond function for pending steps */
  respond?: (response: unknown) => void
  timestamp: number
}

/**
 * Union of all timeline item types.
 */
export type TimelineItem =
  | TimelineUserMessage
  | TimelineAssistantText
  | TimelineThinking
  | TimelineToolCall
  | TimelineStep

// =============================================================================
// GROUPED TIMELINE
// =============================================================================

/**
 * A tool call with its steps grouped together.
 */
export interface TimelineToolCallGroup {
  type: 'tool_call_group'
  toolCall: TimelineToolCall
  steps: TimelineStep[]
}

/**
 * Result of grouping timeline items by tool call.
 */
export type GroupedTimelineItem =
  | TimelineUserMessage
  | TimelineAssistantText
  | TimelineThinking
  | TimelineToolCallGroup

/**
 * Helper to group timeline items by tool call.
 *
 * Useful for rendering tool calls with nested steps, instead of flat inline.
 *
 * @example
 * ```tsx
 * const grouped = groupTimelineByToolCall(timeline)
 * // Returns: Array<TimelineItem | { toolCall: TimelineToolCall, steps: TimelineStep[] }>
 * ```
 */
export function groupTimelineByToolCall(timeline: TimelineItem[]): GroupedTimelineItem[] {
  const result: GroupedTimelineItem[] = []
  const toolCallMap = new Map<string, TimelineToolCallGroup>()

  for (const item of timeline) {
    if (item.type === 'tool_call') {
      const group: TimelineToolCallGroup = {
        type: 'tool_call_group',
        toolCall: item,
        steps: [],
      }
      toolCallMap.set(item.callId, group)
      result.push(group)
    } else if (item.type === 'step') {
      const group = toolCallMap.get(item.callId)
      if (group) {
        group.steps.push(item)
      } else {
        // Orphan step - shouldn't happen, but handle gracefully
        const orphanGroup: TimelineToolCallGroup = {
          type: 'tool_call_group',
          toolCall: {
            type: 'tool_call',
            id: item.callId,
            callId: item.callId,
            toolName: 'unknown',
            input: {},
            state: 'running',
            timestamp: item.timestamp,
          },
          steps: [item],
        }
        toolCallMap.set(item.callId, orphanGroup)
        result.push(orphanGroup)
      }
    } else {
      result.push(item)
    }
  }

  return result
}
