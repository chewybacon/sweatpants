/**
 * Emission Primitives Tests
 *
 * Tests the core primitive layer for tool-to-runtime communication.
 */
import { describe, it, expect, vi } from 'vitest'
import { run, createChannel, spawn, each, sleep } from 'effection'
import {
  createRuntime,
  getComponentKey,
  emissionToTraceEntry,
  createToolTrace,
  COMPONENT_EMISSION_TYPE,
  type Emission,
  type ComponentEmissionPayload,
  type PendingEmission,
  type RuntimeConfig,
} from '../emissions'

describe('Emission Primitives', () => {
  describe('createRuntime', () => {
    it('should emit and receive response through handler', async () => {
      const result = await run(function* () {
        const config: RuntimeConfig = {
          handlers: {
            'test-type': (emission, respond) => {
              // Simulate async response
              setTimeout(() => {
                respond({ received: emission.payload, doubled: (emission.payload as { value: number }).value * 2 })
              }, 10)
            },
          },
        }

        const runtime = createRuntime(config, 'call-1')

        const response = yield* runtime.emit<{ value: number }, { received: { value: number }; doubled: number }>(
          'test-type',
          { value: 21 }
        )

        return response
      })

      expect(result).toEqual({ received: { value: 21 }, doubled: 42 })
    })

    it('should generate unique emission IDs', async () => {
      const emissions: Emission[] = []

      await run(function* () {
        const config: RuntimeConfig = {
          handlers: {
            'track': (emission, respond) => {
              emissions.push(emission)
              respond(undefined)
            },
          },
        }

        const runtime = createRuntime(config, 'call-123')

        yield* runtime.emit('track', { n: 1 })
        yield* runtime.emit('track', { n: 2 })
        yield* runtime.emit('track', { n: 3 })
      })

      expect(emissions).toHaveLength(3)
      expect(emissions[0]!.id).toBe('call-123-em-1')
      expect(emissions[1]!.id).toBe('call-123-em-2')
      expect(emissions[2]!.id).toBe('call-123-em-3')
    })

    it('should set emission status to complete after response', async () => {
      let capturedEmission: Emission | undefined

      await run(function* () {
        const config: RuntimeConfig = {
          handlers: {
            'test': (emission, respond) => {
              capturedEmission = emission
              expect(emission.status).toBe('pending')
              respond('done')
            },
          },
        }

        const runtime = createRuntime(config, 'call-1')
        yield* runtime.emit('test', {})
      })

      expect(capturedEmission).toBeDefined()
      expect(capturedEmission!.status).toBe('complete')
      expect(capturedEmission!.response).toBe('done')
    })

    it('should throw for unknown emission type when fallback is error', async () => {
      await expect(
        run(function* () {
          const config: RuntimeConfig = {
            handlers: {},
            fallback: 'error',
          }

          const runtime = createRuntime(config, 'call-1')
          yield* runtime.emit('unknown-type', {})
        })
      ).rejects.toThrow('No handler for emission type: unknown-type')
    })

    it('should warn and return undefined for unknown type when fallback is warn', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const result = await run(function* () {
        const config: RuntimeConfig = {
          handlers: {},
          fallback: 'warn',
        }

        const runtime = createRuntime(config, 'call-1')
        return yield* runtime.emit('unknown-type', {})
      })

      expect(result).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith('No handler for emission type: unknown-type')
      warnSpy.mockRestore()
    })

    it('should silently ignore unknown type when fallback is ignore', async () => {
      const result = await run(function* () {
        const config: RuntimeConfig = {
          handlers: {},
          fallback: 'ignore',
        }

        const runtime = createRuntime(config, 'call-1')
        return yield* runtime.emit('unknown-type', {})
      })

      expect(result).toBeUndefined()
    })

    it('should send emissions through channel when provided', async () => {
      const receivedEmissions: PendingEmission[] = []

      await run(function* () {
        const channel = createChannel<PendingEmission, void>()

        // Spawn consumer
        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            receivedEmissions.push(pending)
            // Simulate React responding
            pending.respond({ answer: 'yes' })
            yield* each.next()
          }
        })

        const config: RuntimeConfig = {
          handlers: {
            'ask': () => {
              // Handler doesn't respond - channel consumer does
            },
          },
          emissionChannel: channel,
        }

        const runtime = createRuntime(config, 'call-1')

        yield* sleep(0) // Let consumer start

        const response = yield* runtime.emit<{ question: string }, { answer: string }>(
          'ask',
          { question: 'Do you agree?' }
        )

        expect(response).toEqual({ answer: 'yes' })
      })

      expect(receivedEmissions).toHaveLength(1)
      expect(receivedEmissions[0]!.emission.payload).toEqual({ question: 'Do you agree?' })
    })

    it('should handle handler errors', async () => {
      await expect(
        run(function* () {
          const config: RuntimeConfig = {
            handlers: {
              'error': () => {
                throw new Error('Handler exploded')
              },
            },
          }

          const runtime = createRuntime(config, 'call-1')
          yield* runtime.emit('error', {})
        })
      ).rejects.toThrow('Handler exploded')
    })
  })

  describe('getComponentKey', () => {
    it('should use displayName if available', () => {
      const Component = () => null
      Component.displayName = 'MyComponent'
      expect(getComponentKey(Component)).toBe('MyComponent')
    })

    it('should fall back to function name', () => {
      function NamedComponent() {
        return null
      }
      expect(getComponentKey(NamedComponent)).toBe('NamedComponent')
    })

    it('should return Anonymous for anonymous functions', () => {
      expect(getComponentKey(() => null)).toBe('Anonymous')
    })
  })

  describe('emissionToTraceEntry', () => {
    it('should convert emission to trace entry', () => {
      const emission: Emission<ComponentEmissionPayload> = {
        id: 'em-1',
        type: COMPONENT_EMISSION_TYPE,
        payload: {
          componentKey: 'AskQuestion',
          props: { question: 'Do you agree?' },
        },
        timestamp: 1234567890,
        status: 'complete',
        response: { answer: 'yes' },
      }

      const entry = emissionToTraceEntry(emission, 0)

      expect(entry).toEqual({
        order: 0,
        componentKey: 'AskQuestion',
        props: { question: 'Do you agree?' },
        response: { answer: 'yes' },
        timestamp: 1234567890,
      })
    })
  })

  describe('createToolTrace', () => {
    it('should create trace from emissions', () => {
      const emissions: Emission<ComponentEmissionPayload>[] = [
        {
          id: 'em-1',
          type: COMPONENT_EMISSION_TYPE,
          payload: { componentKey: 'Step1', props: { value: 1 } },
          timestamp: 1000,
          status: 'complete',
          response: 'ok',
        },
        {
          id: 'em-2',
          type: COMPONENT_EMISSION_TYPE,
          payload: { componentKey: 'Step2', props: { value: 2 } },
          timestamp: 2000,
          status: 'complete',
          response: { data: 'result' },
        },
      ]

      const trace = createToolTrace(emissions, 500, 3000)

      expect(trace.startedAt).toBe(500)
      expect(trace.completedAt).toBe(3000)
      expect(trace.emissions).toHaveLength(2)
      expect(trace.emissions[0]).toEqual({
        order: 0,
        componentKey: 'Step1',
        props: { value: 1 },
        response: 'ok',
        timestamp: 1000,
      })
      expect(trace.emissions[1]).toEqual({
        order: 1,
        componentKey: 'Step2',
        props: { value: 2 },
        response: { data: 'result' },
        timestamp: 2000,
      })
    })
  })
})

describe('Component Emission Flow', () => {
  it('should support the full render() flow pattern', async () => {
    // This test simulates what ctx.render() will do
    // The handler directly responds rather than going through channel
    // (channel integration is tested separately)

    interface AskQuestionProps {
      question: string
      onRespond?: (value: { answer: string }) => void
    }

    function AskQuestion(_props: AskQuestionProps) {
      return null
    }

    const capturedEmissions: Emission<ComponentEmissionPayload>[] = []

    const result = await run(function* () {
      const config: RuntimeConfig = {
        handlers: {
          [COMPONENT_EMISSION_TYPE]: (emission, respond) => {
            capturedEmissions.push(emission as Emission<ComponentEmissionPayload>)
            // Simulate async user interaction
            setTimeout(() => {
              respond({ answer: 'yes' })
            }, 10)
          },
        },
      }

      const runtime = createRuntime(config, 'call-1')

      // This is what ctx.render() does internally
      const componentKey = getComponentKey(AskQuestion)
      const props = { question: 'Do you agree?' }

      const response = yield* runtime.emit<ComponentEmissionPayload, { answer: string }>(
        COMPONENT_EMISSION_TYPE,
        {
          componentKey,
          props,
          _component: AskQuestion, // Transient reference
        }
      )

      return response
    })

    expect(result).toEqual({ answer: 'yes' })
    expect(capturedEmissions).toHaveLength(1)

    const emission = capturedEmissions[0]!
    expect(emission.payload.componentKey).toBe('AskQuestion')
    expect(emission.payload.props).toEqual({ question: 'Do you agree?' })
    expect(emission.payload._component).toBeDefined()
    expect(emission.status).toBe('complete')
    expect(emission.response).toEqual({ answer: 'yes' })
  })
})
