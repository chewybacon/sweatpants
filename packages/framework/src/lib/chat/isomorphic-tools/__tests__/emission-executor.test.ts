/**
 * Emission Executor Integration Tests
 *
 * Tests the full emission flow through the executor:
 * - executeClientPart with emission channel
 * - BrowserRenderContext creation
 * - ctx.render() emitting through channel
 * - Response resuming the generator
 */
import { describe, it, expect } from './vitest-effection'
import { createChannel, createSignal, spawn, each, sleep } from 'effection'
import { createIsomorphicTool } from '../builder'
import { executeClientPart } from '../executor'
import type { IsomorphicHandoffEvent } from '../types'
import type { ChatPatch } from '../../patches'
import type { PendingEmission, ComponentEmissionPayload } from '../runtime/emissions'
import type { ApprovalSignalValue } from '../runtime/tool-runtime'
import { z } from 'zod'
import type { ComponentType } from 'react'
import type { RenderableProps } from '../runtime/browser-context'

// Helper to cast emission payload
function getPayload(emission: PendingEmission): ComponentEmissionPayload {
  return emission.emission.payload as ComponentEmissionPayload
}

// Mock component for testing
interface MockPickerProps extends RenderableProps<{ picked: string }> {
  options: string[]
}

const MockPicker: ComponentType<MockPickerProps> = () => null
MockPicker.displayName = 'MockPicker'

describe('Emission Executor Integration', () => {
  it('should emit tool_emission_start when executing a tool with emission channel', function* () {
    const patches: ChatPatch[] = []

    const patchChannel = createChannel<ChatPatch, void>()
    const approvalSignal = createSignal<ApprovalSignalValue, void>()
    const emissionChannel = createChannel<PendingEmission, void>()

    // Tool that uses ctx.render()
    const tool = createIsomorphicTool('test_tool')
      .description('Test tool')
      .parameters(z.object({}))
      .context('browser')
      .authority('server')
      .handoff({
        *before() {
          return { options: ['A', 'B', 'C'] }
        },
        *client(_handoff, _ctx: any) {
          // This would call ctx.render() which emits through the channel
          // For now, just return without rendering to test the start patch
          return { picked: 'A' }
        },
        *after(_handoff, client) {
          return { result: client.picked }
        },
      })

    const handoff: IsomorphicHandoffEvent = {
      type: 'isomorphic_handoff',
      callId: 'call-123',
      toolName: 'test_tool',
      params: {},
      serverOutput: { options: ['A', 'B', 'C'] },
      authority: 'server',
      usesHandoff: false,
    }

    // Collect patches
    yield* spawn(function* () {
      for (const patch of yield* each(patchChannel)) {
        patches.push(patch)
        yield* each.next()
      }
    })

    // Auto-approve
    yield* spawn(function* () {
      yield* sleep(10)
      approvalSignal.send({ callId: 'call-123', approved: true })
    })

    yield* executeClientPart(
      tool,
      handoff,
      patchChannel,
      approvalSignal,
      undefined, // no uiRequestChannel
      emissionChannel
    )

    // Give the consumer a moment to process
    yield* sleep(10)
    yield* patchChannel.close()

    // Should have emitted tool_emission_start
    const startPatch = patches.find(p => p.type === 'tool_emission_start')
    expect(startPatch).toBeDefined()
    expect((startPatch as any).callId).toBe('call-123')
    expect((startPatch as any).toolName).toBe('test_tool')
  })

  it('should send emissions through channel when ctx.render() is called', function* () {
    const emissions: PendingEmission[] = []
    const patches: ChatPatch[] = []

    const patchChannel = createChannel<ChatPatch, void>()
    const approvalSignal = createSignal<ApprovalSignalValue, void>()
    const emissionChannel = createChannel<PendingEmission, void>()

    // Tool that renders a component
    const tool = createIsomorphicTool('picker_tool')
      .description('Picker tool')
      .parameters(z.object({}))
      .context('browser')
      .authority('server')
      .handoff({
        *before() {
          return { options: ['X', 'Y', 'Z'] }
        },
        *client(handoff: { options: string[] }, ctx: any) {
          // Call ctx.render() - this should emit through the channel
          const result = yield* ctx.render(MockPicker, {
            options: handoff.options,
          })
          return result
        },
        *after(_handoff, client) {
          return { picked: client.picked }
        },
      })

    const handoff: IsomorphicHandoffEvent = {
      type: 'isomorphic_handoff',
      callId: 'call-456',
      toolName: 'picker_tool',
      params: {},
      serverOutput: { options: ['X', 'Y', 'Z'] },
      authority: 'server',
      usesHandoff: false,
    }

    // Collect patches
    yield* spawn(function* () {
      for (const patch of yield* each(patchChannel)) {
        patches.push(patch)
        yield* each.next()
      }
    })

    // Consume emissions and respond after a delay
    yield* spawn(function* () {
      for (const pending of yield* each(emissionChannel)) {
        emissions.push(pending)
        // Simulate user selecting 'Y'
        yield* sleep(10)
        pending.respond({ picked: 'Y' })
        yield* each.next()
      }
    })

    // Auto-approve
    yield* spawn(function* () {
      yield* sleep(5)
      approvalSignal.send({ callId: 'call-456', approved: true })
    })

    const result = yield* executeClientPart(
      tool,
      handoff,
      patchChannel,
      approvalSignal,
      undefined,
      emissionChannel
    )

    yield* patchChannel.close()
    yield* emissionChannel.close()

    expect(result.ok).toBe(true)
    expect(result.clientOutput).toEqual({ picked: 'Y' })

    // Should have received the emission
    expect(emissions).toHaveLength(1)
    const emission = emissions[0]!
    const payload = getPayload(emission)
    expect(emission.emission.type).toBe('__component__')
    expect(payload.componentKey).toBe('MockPicker')
    expect(payload.props).toEqual({ options: ['X', 'Y', 'Z'] })
    expect(payload._component).toBe(MockPicker)
  })

  it('should handle multiple sequential renders', function* () {
    const emissions: PendingEmission[] = []

    const patchChannel = createChannel<ChatPatch, void>()
    const approvalSignal = createSignal<ApprovalSignalValue, void>()
    const emissionChannel = createChannel<PendingEmission, void>()

    // Mock components
    const Step1: ComponentType<RenderableProps<string>> = () => null
    Step1.displayName = 'Step1'
    
    const Step2: ComponentType<RenderableProps<number>> = () => null
    Step2.displayName = 'Step2'

    const tool = createIsomorphicTool('multi_step')
      .description('Multi-step tool')
      .parameters(z.object({}))
      .context('browser')
      .authority('server')
      .handoff({
        *before() {
          return {}
        },
        *client(_handoff, ctx: any) {
          const first = yield* ctx.render(Step1, {})
          const second = yield* ctx.render(Step2, {})
          return { first, second }
        },
        *after(_handoff, client) {
          return client
        },
      })

    const handoff: IsomorphicHandoffEvent = {
      type: 'isomorphic_handoff',
      callId: 'call-789',
      toolName: 'multi_step',
      params: {},
      serverOutput: {},
      authority: 'server',
      usesHandoff: false,
    }

    // Consume emissions and respond with different values
    yield* spawn(function* () {
      for (const pending of yield* each(emissionChannel)) {
        emissions.push(pending)
        yield* sleep(5)
        // Respond based on component
        const payload = getPayload(pending)
        if (payload.componentKey === 'Step1') {
          pending.respond('hello')
        } else if (payload.componentKey === 'Step2') {
          pending.respond(42)
        }
        yield* each.next()
      }
    })

    // Auto-approve
    yield* spawn(function* () {
      yield* sleep(5)
      approvalSignal.send({ callId: 'call-789', approved: true })
    })

    // Drain patches (we don't need them for this test)
    yield* spawn(function* () {
      for (const _ of yield* each(patchChannel)) {
        yield* each.next()
      }
    })

    const result = yield* executeClientPart(
      tool,
      handoff,
      patchChannel,
      approvalSignal,
      undefined,
      emissionChannel
    )

    yield* patchChannel.close()
    yield* emissionChannel.close()

    expect(result.ok).toBe(true)
    expect(result.clientOutput).toEqual({ first: 'hello', second: 42 })

    // Should have two emissions in order
    expect(emissions).toHaveLength(2)
    expect(getPayload(emissions[0]!).componentKey).toBe('Step1')
    expect(getPayload(emissions[1]!).componentKey).toBe('Step2')
  })
})
