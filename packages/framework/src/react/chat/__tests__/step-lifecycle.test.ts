/**
 * Step Lifecycle E2E Tests
 *
 * These tests verify the expected behavior of ctx.step() inline rendering:
 *
 * 1. Steps should have a single source of truth (executionTrails)
 * 2. pendingSteps should be derived from executionTrails, not a separate copy
 * 3. When a step is responded to, it transitions from pending → complete cleanly
 * 4. No duplicate rendering during the transition
 *
 * The current implementation has issues:
 * - Steps exist in both pendingSteps AND executionTrails
 * - The status in executionTrails doesn't update when step is responded to
 * - UI code needs complex filtering to avoid showing duplicates
 *
 * This test defines the EXPECTED behavior that we want to achieve.
 */
import { describe, it, expect } from 'vitest'
import { run, spawn, each, sleep, createSignal, call } from 'effection'
import { createChatSession } from '../session'
import { createTestStreamer } from '../testing'
import { createIsomorphicToolRegistry, createIsomorphicTool } from '../../../lib/chat/isomorphic-tools'
import type { RenderableProps, ClientStepContext } from '../../../lib/chat/isomorphic-tools'
import type { ChatState, PendingStepState, ExecutionTrailState } from '../types'
import { z } from 'zod'

// =============================================================================
// TEST TOOL - Simple display tool with ctx.step()
// =============================================================================

interface TestDisplayProps extends RenderableProps<void> {
  message: string
}

// Mock component - in real code this would be a React component
function TestDisplay(_props: TestDisplayProps) {
  return null // Not actually rendered in tests
}

const testDisplayTool = createIsomorphicTool('test_display')
  .description('Display a test message')
  .parameters(z.object({
    message: z.string(),
  }))
  .context('browser')
  .authority('client')
  .client(function* (params, ctx) {
    const stepCtx = ctx as ClientStepContext
    yield* stepCtx.step(TestDisplay, { message: params.message })
    return { displayed: true, message: params.message }
  })
  .server(function* (_params, _ctx, clientOutput) {
    return { success: true, ...clientOutput }
  })

// =============================================================================
// HELPER: Collect states and find specific moments
// =============================================================================

interface StepSnapshot {
  pendingSteps: PendingStepState[]
  executionTrails: ExecutionTrailState[]
  pendingStepIds: string[]
  trailStepStatuses: Array<{ id: string; status: string }>
}

function snapshotStepState(state: ChatState): StepSnapshot {
  const pendingSteps = Object.values(state.pendingSteps)
  const executionTrails = Object.values(state.executionTrails)
  
  return {
    pendingSteps,
    executionTrails,
    pendingStepIds: pendingSteps.map(ps => ps.stepId),
    trailStepStatuses: executionTrails.flatMap(trail =>
      trail.steps.map(step => ({ id: step.id, status: step.status }))
    ),
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('Step Lifecycle', () => {
  describe('Single source of truth', () => {
    it('should use executionTrails as the single source of truth for step status', async () => {
      /**
       * EXPECTED BEHAVIOR:
       * 
       * 1. When ctx.step() is called, a step is added to executionTrails with status: 'pending'
       * 2. pendingSteps should be DERIVED from executionTrails (steps where status === 'pending')
       * 3. When respondToStep is called, the step status in executionTrails changes to 'complete'
       * 4. The step automatically disappears from pendingSteps (since it's derived)
       * 5. NO duplicate step data - executionTrails is authoritative
       */
      const snapshots: StepSnapshot[] = []
      let respondFn: ((stepId: string, response: unknown) => void) | null = null

      await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const registry = createIsomorphicToolRegistry([testDisplayTool])

        // Create a signal for step responses (simulating React's respondToStep)
        const stepResponseSignal = createSignal<{ stepId: string; response: unknown }, void>()

        const session = yield* createChatSession({
          streamer,
          transforms: [],
          isomorphicTools: registry,
          enableStepContext: true,
        })

        // Capture the respond function
        respondFn = (stepId: string, response: unknown) => {
          stepResponseSignal.send({ stepId, response })
        }

        // Track the latest state to access pendingSteps
        let latestState: ChatState | null = null

        // Collect state snapshots
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            latestState = state
            snapshots.push(snapshotStepState(state))
            yield* each.next()
          }
        })

        // Handle step responses (simulate useChatSession.respondToStep)
        yield* spawn(function* () {
          for (const { stepId, response } of yield* each(stepResponseSignal)) {
            // Find the pending step and call its respond function
            const pendingStep = latestState?.pendingSteps[stepId]
            if (pendingStep) {
              pendingStep.respond(response)
            }
            yield* each.next()
          }
        })

        yield* sleep(10)

        // Send a message that triggers the tool
        session.dispatch({ type: 'send', content: 'Test' })
        yield* sleep(10)

        // Simulate server returning a tool call for test_display
        yield* call(() => controls.waitForStart())
        yield* controls.emit({
          type: 'tool_calls',
          calls: [{ id: 'call_1', name: 'test_display', arguments: { message: 'Hello' } }],
        })

        // The tool has client authority, so server returns an isomorphic_handoff result
        yield* controls.completeWithHandoff(
          [{
            type: 'isomorphic_handoff',
            callId: 'call_1',
            toolName: 'test_display',
            params: { message: 'Hello' },
            serverOutput: undefined,
            authority: 'client',
            usesHandoff: false,
          }],
          {
            messages: [{ role: 'user', content: 'Test' }],
            assistantContent: '',
            toolCalls: [{ id: 'call_1', name: 'test_display', arguments: { message: 'Hello' } }],
            serverToolResults: [],
          }
        )

        yield* sleep(100)

        // At this point, the step should be:
        // 1. In executionTrails with status: 'pending'
        // 2. In pendingSteps (derived from executionTrails)

        // Now simulate responding to the step
        // (In real code, the component would call onRespond)
        if (respondFn) {
          respondFn('call_1-step-1', undefined)
        }

        yield* sleep(100)

        // After response:
        // 1. executionTrails step status should be 'complete'
        // 2. pendingSteps should be empty (no pending steps left)
      })

      // ASSERTIONS - This is the expected behavior we want

      // Find the snapshot where step was first added (pending)
      const pendingSnapshot = snapshots.find(s => s.pendingStepIds.length > 0)
      expect(pendingSnapshot).toBeDefined()

      if (pendingSnapshot) {
        // The step should exist in executionTrails with status 'pending'
        const trailStep = pendingSnapshot.trailStepStatuses.find(s => s.id.includes('step-1'))
        expect(trailStep).toBeDefined()
        expect(trailStep?.status).toBe('pending')

        // pendingSteps should have exactly the same step (not a copy)
        expect(pendingSnapshot.pendingStepIds).toContain(trailStep?.id)
      }

      // Find the snapshot after step was responded to
      const lastSnapshot = snapshots[snapshots.length - 1]!

      // After response, pendingSteps should be empty
      expect(lastSnapshot.pendingStepIds).toHaveLength(0)

      // The step in executionTrails should now be 'complete'
      const completedStep = lastSnapshot.trailStepStatuses.find(s => s.id.includes('step-1'))
      expect(completedStep).toBeDefined()
      expect(completedStep?.status).toBe('complete')
    })

    it('should NOT have duplicate step data between pendingSteps and executionTrails', async () => {
      /**
       * EXPECTED BEHAVIOR:
       * 
       * At any point in time, a step should only have ONE representation:
       * - It lives in executionTrails.steps[]
       * - pendingSteps is just a filtered view + the respond callback
       * 
       * CURRENT BUG:
       * - Step data is copied to pendingSteps
       * - Status updates don't propagate between the two
       * - UI needs to filter to avoid showing both
       */
      const snapshots: StepSnapshot[] = []

      await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const registry = createIsomorphicToolRegistry([testDisplayTool])

        const session = yield* createChatSession({
          streamer,
          transforms: [],
          isomorphicTools: registry,
          enableStepContext: true,
        })

        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            snapshots.push(snapshotStepState(state))
            yield* each.next()
          }
        })

        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Test' })
        yield* sleep(10)

        yield* call(() => controls.waitForStart())
        yield* controls.emit({
          type: 'tool_calls',
          calls: [{ id: 'call_1', name: 'test_display', arguments: { message: 'Hello' } }],
        })
        yield* controls.completeWithHandoff(
          [{
            type: 'isomorphic_handoff',
            callId: 'call_1',
            toolName: 'test_display',
            params: { message: 'Hello' },
            serverOutput: undefined,
            authority: 'client',
            usesHandoff: false,
          }],
          {
            messages: [{ role: 'user', content: 'Test' }],
            assistantContent: '',
            toolCalls: [{ id: 'call_1', name: 'test_display', arguments: { message: 'Hello' } }],
            serverToolResults: [],
          }
        )

        yield* sleep(200)
      })

      // For every snapshot, check that we don't have duplicate data
      for (const snapshot of snapshots) {
        for (const pendingStep of snapshot.pendingSteps) {
          // The pending step should reference the same data as the trail step
          // NOT be a copy with potentially stale status
          const trailStep = snapshot.trailStepStatuses.find(s => s.id === pendingStep.stepId)
          
          if (trailStep) {
            // If the trail step is complete, it should NOT be in pendingSteps
            if (trailStep.status === 'complete') {
              expect.fail(
                `Step ${pendingStep.stepId} is in pendingSteps but trail shows status='complete'. ` +
                `This causes duplicate rendering in the UI.`
              )
            }
          }
        }
      }
    })
  })

  describe('Step status transitions', () => {
    it('should emit a patch when step status changes from pending to complete', async () => {
      /**
       * EXPECTED BEHAVIOR:
       * 
       * When respondToStep is called:
       * 1. A patch should be emitted to update the step status in executionTrails
       * 2. This is how the UI knows to stop showing the interactive version
       * 
       * FIXED:
       * - The session now wraps the respond callback to emit execution_trail_step_response
       * - This patch updates step status in executionTrails and removes from pendingSteps
       */
      
      // This behavior is verified by the "should use executionTrails as single source of truth" test
      // Here we just verify that the step status is updated in executionTrails after response
      const snapshots: StepSnapshot[] = []
      
      await run(function* () {
        const { streamer, controls } = createTestStreamer()
        const registry = createIsomorphicToolRegistry([testDisplayTool])
        const stepResponseSignal = createSignal<{ stepId: string; response: unknown }, void>()
        
        const session = yield* createChatSession({
          streamer,
          transforms: [],
          isomorphicTools: registry,
          enableStepContext: true,
        })
        
        let latestState: ChatState | null = null
        
        yield* spawn(function* () {
          for (const state of yield* each(session.state)) {
            latestState = state
            snapshots.push(snapshotStepState(state))
            yield* each.next()
          }
        })
        
        yield* spawn(function* () {
          for (const { stepId, response } of yield* each(stepResponseSignal)) {
            const pendingStep = latestState?.pendingSteps[stepId]
            if (pendingStep) {
              pendingStep.respond(response)
            }
            yield* each.next()
          }
        })
        
        yield* sleep(10)
        session.dispatch({ type: 'send', content: 'Test' })
        yield* sleep(10)
        
        yield* call(() => controls.waitForStart())
        yield* controls.emit({
          type: 'tool_calls',
          calls: [{ id: 'call_1', name: 'test_display', arguments: { message: 'Hello' } }],
        })
        yield* controls.completeWithHandoff(
          [{
            type: 'isomorphic_handoff',
            callId: 'call_1',
            toolName: 'test_display',
            params: { message: 'Hello' },
            serverOutput: undefined,
            authority: 'client',
            usesHandoff: false,
          }],
          {
            messages: [{ role: 'user', content: 'Test' }],
            assistantContent: '',
            toolCalls: [{ id: 'call_1', name: 'test_display', arguments: { message: 'Hello' } }],
            serverToolResults: [],
          }
        )
        
        yield* sleep(100)
        
        // Step should be pending before response
        const beforeResponse = snapshots.find(s => s.pendingStepIds.length > 0)
        expect(beforeResponse).toBeDefined()
        expect(beforeResponse?.trailStepStatuses.find(s => s.id.includes('step-1'))?.status).toBe('pending')
        
        // Respond to step
        stepResponseSignal.send({ stepId: 'call_1-step-1', response: undefined })
        yield* sleep(100)
      })
      
      // After response, step status in trail should be 'complete'
      const afterResponse = snapshots[snapshots.length - 1]!
      const stepStatus = afterResponse.trailStepStatuses.find(s => s.id.includes('step-1'))
      expect(stepStatus?.status).toBe('complete')
    })
  })

  describe('Rendering consistency', () => {
    it.skip('should show the same step content during streaming and after settling', async () => {
      /**
       * EXPECTED BEHAVIOR:
       * 
       * The step should appear in the same position relative to other content:
       * - During streaming: tool_call → inline step → streaming text
       * - After settling: tool_call → inline step → settled text
       * 
       * FIXED:
       * - The UI layer now renders trail steps immediately after their associated tool call
       * - This was fixed in the card-game demo's CompletedMessageDisplay component
       * - The state management supports this via executionTrails with steps in order
       * 
       * This test is skipped because it's primarily a UI layer concern.
       * The state provides all necessary data (executionTrails with step positions).
       */
    })
  })
})
