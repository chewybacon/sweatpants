import type { ChatState, ChatPatch, ResponseStep, PendingClientToolState, PendingHandoffState, PendingStepState, ExecutionTrailState } from './types'
import { initialChatState as initialChatStateBase } from './types'

export type { ChatState, PendingClientToolState, PendingHandoffState, PendingStepState, ExecutionTrailState }

export const initialChatState = initialChatStateBase

/**
 * Helper to commit the active step to the current response.
 * Returns the updated currentResponse array.
 */
function commitActiveStep(
  currentResponse: ResponseStep[],
  activeStep: ChatState['activeStep']
): ResponseStep[] {
  if (!activeStep) return currentResponse
  return [...currentResponse, activeStep]
}

/**
 * Consolidate the step chain for final display.
 * - Merges all text steps into a single text step (final answer)
 * - Keeps thinking and tool_call steps as-is
 */
function consolidateSteps(steps: ResponseStep[]): ResponseStep[] {
  const consolidated: ResponseStep[] = []
  let mergedText = ''

  for (const step of steps) {
    if (step.type === 'text') {
      // Accumulate all text content
      mergedText += step.content
    } else {
      // Keep thinking and tool_call steps
      consolidated.push(step)
    }
  }

  // Add merged text as final step if we have any
  if (mergedText) {
    consolidated.push({ type: 'text', content: mergedText })
  }

  return consolidated
}

/**
 * Apply a patch to the chat state (pure reducer).
 *
 * Uses a step chain model:
 * - `currentResponse` accumulates completed steps
 * - `activeStep` holds the currently streaming step
 * - On step type transitions, activeStep is committed to currentResponse
 */
export function chatReducer(state: ChatState, patch: ChatPatch): ChatState {
  switch (patch.type) {
    case 'session_info':
      return {
        ...state,
        capabilities: patch.capabilities,
        persona: patch.persona,
      }

    case 'user_message':
      return {
        ...state,
        messages: [...state.messages, patch.message],
        // Store rendered content if provided
        rendered: patch.rendered
          ? { ...state.rendered, [patch.message.id]: { output: patch.rendered } }
          : state.rendered,
        error: null,
      }

    case 'streaming_start':
      return {
        ...state,
        isStreaming: true,
        currentResponse: [],
        activeStep: null,
        error: null,
        buffer: {
          settled: '',
          pending: '',
          settledHtml: '',
        },
        // Clear pending steps from previous request
        pendingSteps: {},
      }

    case 'streaming_thinking': {
      // If we're already streaming thinking, append
      if (state.activeStep?.type === 'thinking') {
        return {
          ...state,
          activeStep: {
            type: 'thinking',
            content: state.activeStep.content + patch.content,
          },
        }
      }
      // Otherwise, commit current step and start new thinking step
      return {
        ...state,
        currentResponse: commitActiveStep(
          state.currentResponse,
          state.activeStep
        ),
        activeStep: { type: 'thinking', content: patch.content },
      }
    }

    case 'streaming_text': {
      // If we're already streaming text, append
      if (state.activeStep?.type === 'text') {
        return {
          ...state,
          activeStep: {
            type: 'text',
            content: state.activeStep.content + patch.content,
          },
        }
      }
      // Otherwise, commit current step and start new text step
      return {
        ...state,
        currentResponse: commitActiveStep(
          state.currentResponse,
          state.activeStep
        ),
        activeStep: { type: 'text', content: patch.content },
      }
    }

    case 'tool_call_start': {
      // Tool calls interrupt streaming - commit active step first
      const newResponse = commitActiveStep(
        state.currentResponse,
        state.activeStep
      )

      // Add the tool call as a pending step
      const toolStep: ResponseStep = {
        type: 'tool_call',
        id: patch.call.id,
        name: patch.call.name,
        arguments: patch.call.arguments,
        state: 'pending',
      }

      return {
        ...state,
        currentResponse: [...newResponse, toolStep],
        activeStep: null,
      }
    }

    case 'tool_call_result': {
      // Update matching tool call in currentResponse
      return {
        ...state,
        currentResponse: state.currentResponse.map((step) =>
          step.type === 'tool_call' && step.id === patch.id
            ? { ...step, state: 'complete' as const, result: patch.result }
            : step
        ),
      }
    }

    case 'tool_call_error': {
      // Update matching tool call in currentResponse
      return {
        ...state,
        currentResponse: state.currentResponse.map((step) =>
          step.type === 'tool_call' && step.id === patch.id
            ? { ...step, state: 'error' as const, error: patch.error }
            : step
        ),
      }
    }

    case 'assistant_message': {
      // Commit final active step
      const finalResponse = commitActiveStep(
        state.currentResponse,
        state.activeStep
      )

      // Consolidate steps (merge all text into single final text step)
      const consolidatedSteps = consolidateSteps(finalResponse)

      // Create message with step chain
      const messageWithSteps: ChatState['messages'][0] = {
        ...patch.message,
        steps: consolidatedSteps.length > 0 ? consolidatedSteps : undefined,
      }

      // Get rendered output from patch (if provided) or from buffer (accumulated during streaming)
      const output = patch.rendered || state.buffer.settledHtml || undefined

      return {
        ...state,
        messages: [...state.messages, messageWithSteps],
        // Store rendered content
        rendered: output
          ? { ...state.rendered, [patch.message.id]: { output } }
          : state.rendered,
        currentResponse: [],
        activeStep: null,
      }
    }

    case 'streaming_end':
      return {
        ...state,
        isStreaming: false,
      }

    case 'abort_complete': {
      // User aborted - preserve partial content if message provided
      if (patch.message) {
        // Commit any active step
        const finalResponse = commitActiveStep(
          state.currentResponse,
          state.activeStep
        )
        const consolidatedSteps = consolidateSteps(finalResponse)

        // Create message with step chain
        const messageWithSteps: ChatState['messages'][0] = {
          ...patch.message,
          steps: consolidatedSteps.length > 0 ? consolidatedSteps : undefined,
        }

        // Use the rendered HTML from the patch (settled content only)
        const output = patch.rendered || state.buffer.settledHtml || undefined

        return {
          ...state,
          messages: [...state.messages, messageWithSteps],
          rendered: output
            ? { ...state.rendered, [patch.message.id]: { output } }
            : state.rendered,
          currentResponse: [],
          activeStep: null,
          isStreaming: false,
          buffer: initialChatState.buffer, // Reset buffer
        }
      }

      // No message to preserve - just end streaming
      return {
        ...state,
        isStreaming: false,
        currentResponse: [],
        activeStep: null,
        buffer: initialChatState.buffer,
      }
    }

    case 'error':
      return {
        ...state,
        error: patch.message,
        isStreaming: false,
      }

    case 'reset':
      return initialChatState

    // Dual buffer patches
    case 'buffer_settled':
      return {
        ...state,
        buffer: {
          ...state.buffer,
          settled: patch.next,
          // If processor enriched with HTML, update settledHtml too
          settledHtml: patch.html ?? state.buffer.settledHtml,
        },
      }

    case 'buffer_pending':
      return {
        ...state,
        buffer: {
          ...state.buffer,
          pending: patch.content,
        },
      }

    // --- Client Tool Patches ---

    case 'client_tool_awaiting_approval':
      return {
        ...state,
        pendingClientTools: {
          ...state.pendingClientTools,
          [patch.id]: {
            id: patch.id,
            name: patch.name,
            state: 'awaiting_approval',
            approvalMessage: patch.message,
          },
        },
      }

    case 'client_tool_executing':
      return {
        ...state,
        pendingClientTools: {
          ...state.pendingClientTools,
          [patch.id]: {
            ...state.pendingClientTools[patch.id],
            state: 'executing',
          },
        },
      }

    case 'client_tool_complete': {
      // Remove from pending and we could track completed tools elsewhere if needed
      const { [patch.id]: completed, ...remaining } = state.pendingClientTools
      return {
        ...state,
        pendingClientTools: {
          ...remaining,
          [patch.id]: {
            ...completed,
            state: 'complete',
            result: patch.result,
          },
        },
      }
    }

    case 'client_tool_error': {
      return {
        ...state,
        pendingClientTools: {
          ...state.pendingClientTools,
          [patch.id]: {
            ...state.pendingClientTools[patch.id],
            state: 'error',
            error: patch.error,
          },
        },
      }
    }

    case 'client_tool_denied': {
      return {
        ...state,
        pendingClientTools: {
          ...state.pendingClientTools,
          [patch.id]: {
            ...state.pendingClientTools[patch.id],
            state: 'denied',
            denialReason: patch.reason,
          },
        },
      }
    }

    case 'client_tool_progress': {
      return {
        ...state,
        pendingClientTools: {
          ...state.pendingClientTools,
          [patch.id]: {
            ...state.pendingClientTools[patch.id],
            progressMessage: patch.message,
          },
        },
      }
    }

    case 'client_tool_permission_request': {
      return {
        ...state,
        pendingClientTools: {
          ...state.pendingClientTools,
          [patch.id]: {
            ...state.pendingClientTools[patch.id],
            state: 'awaiting_approval',
            permissionType: patch.permissionType,
          },
        },
      }
    }

    // --- Tool Handoff Patches (for React Tool Handlers) ---

    case 'pending_handoff': {
      return {
        ...state,
        pendingHandoffs: {
          ...state.pendingHandoffs,
          [patch.handoff.callId]: patch.handoff,
        },
      }
    }

    case 'handoff_complete': {
      // Remove the completed handoff from pending state
      const { [patch.callId]: _completed, ...remaining } = state.pendingHandoffs
      return {
        ...state,
        pendingHandoffs: remaining,
      }
    }

    // --- Execution Trail Patches (for ctx.render pattern) ---

    case 'execution_trail_start': {
      return {
        ...state,
        executionTrails: {
          ...state.executionTrails,
          [patch.callId]: {
            callId: patch.callId,
            toolName: patch.toolName,
            steps: [],
            status: 'running',
            startedAt: Date.now(),
          },
        },
      }
    }

    case 'execution_trail_step': {
      const step = patch.step
      const callId = patch.callId

      // Add step to the execution trail
      const trail = state.executionTrails[callId]
      const updatedTrail = trail
        ? { ...trail, steps: [...trail.steps, step] }
        : {
            callId,
            toolName: '',
            steps: [step],
            status: 'running' as const,
            startedAt: step.timestamp,
          }

      // If it's a prompt step (waiting for response), also add to pendingSteps
      if (step.kind === 'prompt' && step.status === 'pending' && patch.respond) {
        return {
          ...state,
          executionTrails: {
            ...state.executionTrails,
            [callId]: updatedTrail,
          },
          pendingSteps: {
            ...state.pendingSteps,
            [step.id]: {
              stepId: step.id,
              callId,
              kind: step.kind,
              type: step.type,
              payload: step.payload,
              element: step.element,
              component: step.component, // Include component for factory pattern
              timestamp: step.timestamp,
              respond: patch.respond,
            },
          },
        }
      }

      return {
        ...state,
        executionTrails: {
          ...state.executionTrails,
          [callId]: updatedTrail,
        },
      }
    }

    case 'execution_trail_complete': {
      const { [patch.callId]: _completed, ...remainingSteps } = state.pendingSteps
      
      // Remove any pending steps for this call
      const newPendingSteps = Object.fromEntries(
        Object.entries(remainingSteps).filter(([_, step]) => step.callId !== patch.callId)
      )

      // Update trail status
      const trail = state.executionTrails[patch.callId]
      if (!trail) return state

      return {
        ...state,
        executionTrails: {
          ...state.executionTrails,
          [patch.callId]: {
            ...trail,
            status: patch.error ? 'error' : 'complete',
            completedAt: Date.now(),
            result: patch.result,
            error: patch.error,
          },
        },
        pendingSteps: newPendingSteps,
      }
    }

    case 'execution_trail_step_response': {
      const { stepId, callId, response } = patch
      
      // Update step status in executionTrails
      const trail = state.executionTrails[callId]
      if (!trail) {
        return state
      }
      
      const updatedSteps = trail.steps.map(step => 
        step.id === stepId 
          ? { ...step, status: 'complete' as const, response }
          : step
      )
      
      // Remove from pendingSteps
      const { [stepId]: _removed, ...remainingPendingSteps } = state.pendingSteps
      
      return {
        ...state,
        executionTrails: {
          ...state.executionTrails,
          [callId]: {
            ...trail,
            steps: updatedSteps,
          },
        },
        pendingSteps: remainingPendingSteps,
      }
    }

    default:
      return state
  }
}
