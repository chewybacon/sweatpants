/**
 * useBackgroundTask Hook Tests
 * 
 * Tests for the background task hook that allows running operations
 * without blocking the parent scope.
 */
import { describe, it, expect } from './vitest-effection.ts'
import { it as plainIt } from 'vitest'
import { 
  sleep, 
  createScope, 
  call,
  createContext,
} from 'effection'
import { useBackgroundTask, fireAndForget, useTaskPool } from '../use-background-task.ts'

// =============================================================================
// TEST CONTEXTS
// =============================================================================

// Create test contexts to verify context propagation
const TestStringContext = createContext<string>('TestString')
const TestNumberContext = createContext<number>('TestNumber')
const TestObjectContext = createContext<{ name: string; value: number }>('TestObject')

// =============================================================================
// BASIC FUNCTIONALITY
// =============================================================================

describe('useBackgroundTask', () => {
  describe('basic functionality', () => {
    it('should start task and return handle immediately', function* () {
      const events: string[] = []
      
      const handle = yield* useBackgroundTask(function* () {
        events.push('task start')
        yield* sleep(50)
        events.push('task end')
      })
      
      events.push('after useBackgroundTask')
      
      // Task should be running
      expect(handle.status()).toBe('running')
      expect(handle.isDone()).toBe(false)
      expect(events).toContain('after useBackgroundTask')
      
      // Wait for task to complete
      yield* handle.waitForDone()
      
      expect(handle.status()).toBe('complete')
      expect(handle.isDone()).toBe(true)
      expect(events).toContain('task end')
    })

    it('should capture task result', function* () {
      const handle = yield* useBackgroundTask(function* () {
        yield* sleep(10)
        return 42
      })
      
      yield* handle.waitForDone()
      
      expect(handle.status()).toBe('complete')
      expect(handle.result()).toBe(42)
    })

    it('should capture task error', function* () {
      const handle = yield* useBackgroundTask(function* () {
        yield* sleep(10)
        throw new Error('test error')
      })
      
      const finalStatus = yield* handle.waitForDone()
      
      expect(finalStatus).toBe('error')
      expect(handle.status()).toBe('error')
      expect(handle.error()?.message).toBe('test error')
    })

    it('should allow halting a running task', function* () {
      const events: string[] = []
      
      const handle = yield* useBackgroundTask(function* () {
        events.push('task start')
        yield* sleep(1000) // Long sleep
        events.push('task end') // Should not reach here
      })
      
      // Let it start
      yield* sleep(10)
      expect(events).toContain('task start')
      
      // Halt it
      yield* handle.halt()
      
      expect(handle.status()).toBe('halted')
      expect(handle.isDone()).toBe(true)
      expect(events).not.toContain('task end')
    })
  })

  // =============================================================================
  // SCOPE BEHAVIOR
  // =============================================================================

  describe('scope behavior', () => {
    it('should not block parent scope completion', function* () {
      const events: string[] = []
      
      const [parentScope, destroyParent] = createScope()
      
      // Run in parent scope
      const resultPromise = parentScope.run(function* () {
        events.push('parent start')
        
        const handle = yield* useBackgroundTask(function* () {
          events.push('bg start')
          yield* sleep(100)
          events.push('bg end')
        })
        
        events.push('parent end')
        return handle
      })
      
      // Parent should complete quickly
      const handle = yield* call(() => resultPromise)
      events.push('parentScope.run completed')
      
      // Background should still be running
      expect(handle.isDone()).toBe(false)
      expect(events).toContain('parentScope.run completed')
      expect(events).toContain('bg start')
      
      // Wait for background
      yield* handle.waitForDone()
      expect(events).toContain('bg end')
      
      yield* call(() => destroyParent())
    })

    it('should use external scope when provided', function* () {
      const events: string[] = []
      
      const [externalScope, destroyExternal] = createScope()
      
      const handle = yield* useBackgroundTask(function* () {
        events.push('task running')
        yield* sleep(50)
        events.push('task done')
      }, { scope: externalScope })
      
      expect(handle.status()).toBe('running')
      
      // Wait for completion
      yield* handle.waitForDone()
      expect(events).toContain('task done')
      
      yield* call(() => destroyExternal())
    })
  })

  // =============================================================================
  // CALLBACKS
  // =============================================================================

  describe('callbacks', () => {
    it('should call onComplete when task finishes successfully', function* () {
      let completeCalled = false
      
      const handle = yield* useBackgroundTask(function* () {
        yield* sleep(10)
        return 'success'
      }, {
        onComplete: () => { completeCalled = true }
      })
      
      yield* handle.waitForDone()
      
      expect(completeCalled).toBe(true)
    })

    it('should call onError when task fails', function* () {
      let errorCalled = false
      let capturedError: Error | undefined
      
      const handle = yield* useBackgroundTask(function* () {
        yield* sleep(10)
        throw new Error('test failure')
      }, {
        onError: (err) => { 
          errorCalled = true
          capturedError = err
        }
      })
      
      yield* handle.waitForDone()
      
      expect(errorCalled).toBe(true)
      expect(capturedError?.message).toBe('test failure')
    })

    it('should call onHalt when task is halted', function* () {
      let haltCalled = false
      
      const handle = yield* useBackgroundTask(function* () {
        yield* sleep(1000)
      }, {
        onHalt: () => { haltCalled = true }
      })
      
      yield* sleep(10)
      yield* handle.halt()
      
      expect(haltCalled).toBe(true)
    })
  })

  // =============================================================================
  // MULTIPLE WAITERS
  // =============================================================================

  describe('multiple waiters', () => {
    it('should support multiple waitForDone calls', function* () {
      const handle = yield* useBackgroundTask(function* () {
        yield* sleep(50)
        return 'done'
      })
      
      // Multiple waiters should all resolve
      const [status1, status2] = yield* call(() => Promise.all([
        (async () => {
          const [scope1, destroy1] = createScope()
          const result = await scope1.run(function* () {
            return yield* handle.waitForDone()
          })
          await destroy1()
          return result
        })(),
        (async () => {
          const [scope2, destroy2] = createScope()
          const result = await scope2.run(function* () {
            return yield* handle.waitForDone()
          })
          await destroy2()
          return result
        })(),
      ]))
      
      expect(status1).toBe('complete')
      expect(status2).toBe('complete')
    })
  })
})

// =============================================================================
// FIRE AND FORGET
// =============================================================================

describe('fireAndForget', () => {
  it('should run operation without blocking', function* () {
    const events: string[] = []
    
    yield* fireAndForget(function* () {
      events.push('fire start')
      yield* sleep(50)
      events.push('fire end')
    })
    
    events.push('after fireAndForget')
    
    // Should continue immediately
    expect(events).toContain('after fireAndForget')
    
    // Wait for the fire-and-forget to complete
    yield* sleep(100)
    expect(events).toContain('fire end')
  })
})

// =============================================================================
// TASK POOL
// =============================================================================

describe('useTaskPool', () => {
  it('should limit concurrent tasks', function* () {
    const events: string[] = []
    let maxConcurrent = 0
    let currentConcurrent = 0
    
    const pool = yield* useTaskPool(2)
    
    // Submit 5 tasks
    for (let i = 0; i < 5; i++) {
      yield* pool.submit(function* () {
        currentConcurrent++
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
        events.push(`task ${i} start (concurrent: ${currentConcurrent})`)
        
        yield* sleep(20)
        
        currentConcurrent--
        events.push(`task ${i} end`)
      })
    }
    
    yield* pool.waitAll()
    
    // Should never exceed max concurrent
    expect(maxConcurrent).toBeLessThanOrEqual(2)
    expect(events.filter(e => e.includes('end')).length).toBe(5)
  })

  it('should halt all tasks', function* () {
    const events: string[] = []
    
    const pool = yield* useTaskPool(3)
    
    // Submit long-running tasks
    for (let i = 0; i < 3; i++) {
      yield* pool.submit(function* () {
        events.push(`task ${i} start`)
        yield* sleep(1000)
        events.push(`task ${i} end`)
      })
    }
    
    // Let them start
    yield* sleep(10)
    
    // Halt all
    yield* pool.haltAll()
    
    // Tasks should have started but not ended
    expect(events.filter(e => e.includes('start')).length).toBe(3)
    expect(events.filter(e => e.includes('end')).length).toBe(0)
  })

  it('should report active count', function* () {
    const pool = yield* useTaskPool(2)
    
    expect(pool.activeCount()).toBe(0)
    
    yield* pool.submit(function* () {
      yield* sleep(100)
    })
    
    // Give it a moment to start
    yield* sleep(10)
    expect(pool.activeCount()).toBe(1)
    
    yield* pool.waitAll()
    expect(pool.activeCount()).toBe(0)
  })
})

// =============================================================================
// NESTED SCOPES
// =============================================================================

describe('nested scopes', () => {
  it('should work with deeply nested background tasks', function* () {
    const events: string[] = []
    
    // Level 1: outer background task
    const outerHandle = yield* useBackgroundTask(function* () {
      events.push('outer start')
      
      // Level 2: inner background task
      const innerHandle = yield* useBackgroundTask(function* () {
        events.push('inner start')
        
        // Level 3: deepest background task
        const deepHandle = yield* useBackgroundTask(function* () {
          events.push('deep start')
          yield* sleep(20)
          events.push('deep end')
          return 'deep-result'
        })
        
        events.push('inner waiting for deep')
        yield* deepHandle.waitForDone()
        events.push('inner end')
        return 'inner-result'
      })
      
      events.push('outer waiting for inner')
      yield* innerHandle.waitForDone()
      events.push('outer end')
      return 'outer-result'
    })
    
    events.push('after outer spawn')
    
    // All tasks should be running
    expect(events).toContain('after outer spawn')
    
    // Wait for everything to complete
    yield* outerHandle.waitForDone()
    
    expect(outerHandle.status()).toBe('complete')
    expect(outerHandle.result()).toBe('outer-result')
    expect(events).toContain('deep end')
    expect(events).toContain('inner end')
    expect(events).toContain('outer end')
  })

  it('should handle errors in nested background tasks', function* () {
    const events: string[] = []
    
    const outerHandle = yield* useBackgroundTask(function* () {
      events.push('outer start')
      
      const innerHandle = yield* useBackgroundTask(function* () {
        events.push('inner start')
        yield* sleep(10)
        throw new Error('inner error')
      })
      
      events.push('outer waiting for inner')
      const innerStatus = yield* innerHandle.waitForDone()
      events.push(`inner finished with: ${innerStatus}`)
      
      if (innerStatus === 'error') {
        events.push(`inner error was: ${innerHandle.error()?.message}`)
      }
      
      events.push('outer end')
      return 'outer-result'
    })
    
    yield* outerHandle.waitForDone()
    
    expect(outerHandle.status()).toBe('complete')
    expect(events).toContain('inner finished with: error')
    expect(events).toContain('inner error was: inner error')
    expect(events).toContain('outer end')
  })

  it('should allow halting parent without affecting already-completed children', function* () {
    const events: string[] = []
    
    const outerHandle = yield* useBackgroundTask(function* () {
      events.push('outer start')
      
      // Quick child that completes first
      const quickChild = yield* useBackgroundTask(function* () {
        events.push('quick start')
        yield* sleep(10)
        events.push('quick end')
      })
      
      yield* quickChild.waitForDone()
      events.push('quick child done')
      
      // Long sleep that we'll interrupt
      yield* sleep(1000)
      events.push('outer end') // Should not reach
    })
    
    // Wait for quick child to complete
    yield* sleep(50)
    expect(events).toContain('quick end')
    expect(events).toContain('quick child done')
    
    // Halt the outer task
    yield* outerHandle.halt()
    
    expect(outerHandle.status()).toBe('halted')
    expect(events).not.toContain('outer end')
  })
})

// =============================================================================
// CONTEXT PROPAGATION
// =============================================================================

describe('context propagation', () => {
  it('should NOT automatically inherit contexts (independent scope)', function* () {
    // Set contexts in current scope
    yield* TestStringContext.set('parent-string')
    yield* TestNumberContext.set(42)
    
    let capturedString: string | undefined
    let capturedNumber: number | undefined
    
    const handle = yield* useBackgroundTask(function* () {
      // Background task runs in independent scope - no context inheritance
      capturedString = yield* TestStringContext.get()
      capturedNumber = yield* TestNumberContext.get()
    })
    
    yield* handle.waitForDone()
    
    // Contexts are NOT inherited by default (independent scope)
    expect(capturedString).toBeUndefined()
    expect(capturedNumber).toBeUndefined()
  })

  it('should pass contexts via contexts option', function* () {
    // Set contexts in current scope
    yield* TestStringContext.set('parent-string')
    yield* TestNumberContext.set(42)
    
    // Capture context values
    const stringValue = yield* TestStringContext.get()
    const numberValue = yield* TestNumberContext.get()
    
    let capturedString: string | undefined
    let capturedNumber: number | undefined
    
    const handle = yield* useBackgroundTask(function* () {
      capturedString = yield* TestStringContext.get()
      capturedNumber = yield* TestNumberContext.get()
    }, {
      contexts: [
        { context: TestStringContext, value: stringValue! },
        { context: TestNumberContext, value: numberValue! },
      ]
    })
    
    yield* handle.waitForDone()
    
    // Contexts should be available via explicit passing
    expect(capturedString).toBe('parent-string')
    expect(capturedNumber).toBe(42)
  })

  it('should allow complex object contexts via contexts option', function* () {
    const originalObject = { name: 'test', value: 123 }
    yield* TestObjectContext.set(originalObject)
    
    const objValue = yield* TestObjectContext.get()
    
    let bgObject: { name: string; value: number } | undefined
    
    const handle = yield* useBackgroundTask(function* () {
      bgObject = yield* TestObjectContext.get()
      
      // Modify to verify it's the same reference
      if (bgObject) {
        bgObject.value = 456
      }
    }, {
      contexts: [{ context: TestObjectContext, value: objValue! }]
    })
    
    yield* handle.waitForDone()
    
    expect(bgObject).toBeDefined()
    expect(bgObject?.name).toBe('test')
    // The modification should be visible since it's the same object reference
    expect(originalObject.value).toBe(456)
  })

  it('should maintain context isolation between sibling background tasks', function* () {
    yield* TestStringContext.set('parent')
    const parentValue = yield* TestStringContext.get()
    
    let task1Value: string | undefined
    let task2Value: string | undefined
    
    const handle1 = yield* useBackgroundTask(function* () {
      // Starts with passed value
      const inherited = yield* TestStringContext.get()
      expect(inherited).toBe('parent')
      
      // Override in this scope
      yield* TestStringContext.set('task1-value')
      yield* sleep(30)
      task1Value = yield* TestStringContext.get()
    }, {
      contexts: [{ context: TestStringContext, value: parentValue! }]
    })
    
    const handle2 = yield* useBackgroundTask(function* () {
      // Starts with passed value (not task1's!)
      const inherited = yield* TestStringContext.get()
      expect(inherited).toBe('parent')
      
      // Override in this scope
      yield* TestStringContext.set('task2-value')
      yield* sleep(10)
      task2Value = yield* TestStringContext.get()
    }, {
      contexts: [{ context: TestStringContext, value: parentValue! }]
    })
    
    yield* handle1.waitForDone()
    yield* handle2.waitForDone()
    
    // Each task should have its own context value
    expect(task1Value).toBe('task1-value')
    expect(task2Value).toBe('task2-value')
    
    // Parent context should be unchanged
    const finalParentValue = yield* TestStringContext.get()
    expect(finalParentValue).toBe('parent')
  })

  it('should work with the logger context pattern via closure', function* () {
    // Simulate the logger context pattern from the framework
    const LoggerContext = createContext<{ debug: (msg: string) => void }>('Logger')
    
    const logs: string[] = []
    const parentLogger = { debug: (msg: string) => logs.push(`parent: ${msg}`) }
    
    yield* LoggerContext.set(parentLogger)
    
    // Capture logger via closure
    const logger = yield* LoggerContext.get()
    
    const handle = yield* useBackgroundTask(function* () {
      // Use captured logger via closure
      logger?.debug('from background using closure')
      
      // Can also set up a new context in the background scope
      const childLogger = { debug: (msg: string) => logs.push(`child: ${msg}`) }
      yield* LoggerContext.set(childLogger)
      
      const bgLogger = yield* LoggerContext.get()
      bgLogger?.debug('from background using child logger')
    })
    
    yield* handle.waitForDone()
    
    expect(logs).toContain('parent: from background using closure')
    expect(logs).toContain('child: from background using child logger')
  })

  it('should work with contexts option for nested background tasks', function* () {
    yield* TestStringContext.set('root-value')
    yield* TestNumberContext.set(100)
    
    const rootString = yield* TestStringContext.get()
    const rootNumber = yield* TestNumberContext.get()
    
    let level1String: string | undefined
    let level2String: string | undefined
    let level2Number: number | undefined
    
    const handle = yield* useBackgroundTask(function* () {
      level1String = yield* TestStringContext.get()
      
      // Modify context in level 1
      yield* TestNumberContext.set(200)
      const level1Number = yield* TestNumberContext.get()
      
      // Nested background task - pass updated context
      const innerHandle = yield* useBackgroundTask(function* () {
        level2String = yield* TestStringContext.get()
        level2Number = yield* TestNumberContext.get()
      }, {
        contexts: [
          { context: TestStringContext, value: level1String! },
          { context: TestNumberContext, value: level1Number! },
        ]
      })
      
      yield* innerHandle.waitForDone()
    }, {
      contexts: [
        { context: TestStringContext, value: rootString! },
        { context: TestNumberContext, value: rootNumber! },
      ]
    })
    
    yield* handle.waitForDone()
    
    expect(level1String).toBe('root-value')
    expect(level2String).toBe('root-value')
    expect(level2Number).toBe(200) // Should see level 1's modified value
  })
})

// =============================================================================
// CONTEXT PROPAGATION WITH EXTERNAL SCOPE
// =============================================================================

describe('context propagation with external scope', () => {
  it('should NOT persist contexts across scope.run() calls (Effection behavior)', function* () {
    // NOTE: This test documents Effection's behavior - contexts are scoped to
    // the operation tree, not the Scope object itself. Each scope.run() starts
    // a fresh context hierarchy.
    
    const [externalScope, destroyExternal] = createScope()
    
    // Set contexts in first run
    yield* call(() => externalScope.run(function* () {
      yield* TestStringContext.set('first-run-value')
    }))
    
    // Try to read in second run
    let capturedString: string | undefined
    yield* call(() => externalScope.run(function* () {
      capturedString = yield* TestStringContext.get()
    }))
    
    // Context does NOT persist across scope.run() calls
    expect(capturedString).toBeUndefined()
    
    yield* call(() => destroyExternal())
  })

  it('should use external scope directly when provided', function* () {
    // Set context in current scope
    yield* TestStringContext.set('current-scope-value')
    
    const [externalScope, destroyExternal] = createScope()
    
    let capturedString: string | undefined
    
    // When using external scope, no context is available unless passed
    const handle = yield* useBackgroundTask(function* () {
      capturedString = yield* TestStringContext.get()
    }, { scope: externalScope })
    
    yield* handle.waitForDone()
    
    // External scope doesn't have our context
    expect(capturedString).toBeUndefined()
    
    yield* call(() => destroyExternal())
  })

  it('should pass contexts to external scope via contexts option', function* () {
    // Set context in current scope
    yield* TestStringContext.set('parent-value')
    const parentValue = yield* TestStringContext.get()
    
    const [externalScope, destroyExternal] = createScope()
    
    let capturedString: string | undefined
    
    // Pass context explicitly
    const handle = yield* useBackgroundTask(function* () {
      capturedString = yield* TestStringContext.get()
    }, { 
      scope: externalScope,
      contexts: [{ context: TestStringContext, value: parentValue! }]
    })
    
    yield* handle.waitForDone()
    
    // Context should be available via explicit passing
    expect(capturedString).toBe('parent-value')
    
    yield* call(() => destroyExternal())
  })
})

// =============================================================================
// INTEGRATION TEST: DURABLE HANDLER PATTERN
// =============================================================================

describe('durable handler pattern integration', () => {
  it('should work with logger captured via closure (like durable handler)', function* () {
    // This simulates the pattern used in the durable chat handler
    // Capture logger before spawning background task
    
    const LoggerContext = createContext<{ debug: (obj: object, msg: string) => void }>('Logger')
    const logs: Array<{ scope: string; obj: object; msg: string }> = []
    
    // Set up logger in parent scope (like setupLogger hook does)
    yield* LoggerContext.set({
      debug: (obj, msg) => logs.push({ scope: 'parent', obj, msg })
    })
    
    // Capture logger via closure (the pattern used in the actual handler)
    const log = yield* LoggerContext.get()
    
    // Simulate buffer that writer will write to
    const buffer: string[] = []
    
    // Start background writer (like the durable handler does)
    const writerHandle = yield* useBackgroundTask(function* () {
      // Writer uses captured logger via closure
      log?.debug({ phase: 'start' }, 'writer starting')
      
      // Simulate writing tokens
      for (const token of ['hello', 'world']) {
        yield* sleep(10)
        buffer.push(token)
        log?.debug({ token, bufferSize: buffer.length }, 'wrote token')
      }
      
      log?.debug({ phase: 'end', totalTokens: buffer.length }, 'writer complete')
    })
    
    // Parent continues immediately
    expect(writerHandle.status()).toBe('running')
    
    // Wait for writer
    yield* writerHandle.waitForDone()
    
    expect(buffer).toEqual(['hello', 'world'])
    expect(logs.length).toBe(4) // start, 2 tokens, end
    expect(logs[0]?.msg).toBe('writer starting')
    expect(logs[3]?.msg).toBe('writer complete')
  })

  it('should work with nested background tasks using closure', function* () {
    // Simulate a more complex scenario with nested tasks
    // Using closure pattern for sharing state
    
    const events: string[] = []
    const SharedStateContext = createContext<{ items: string[] }>('SharedState')
    
    // Set up shared state
    const sharedState = { items: [] as string[] }
    yield* SharedStateContext.set(sharedState)
    
    // Capture via closure
    const state = yield* SharedStateContext.get()
    
    // Outer background task that spawns inner tasks
    const outerHandle = yield* useBackgroundTask(function* () {
      events.push('outer start')
      
      // Use captured state via closure
      state?.items.push('from-outer')
      
      // Spawn inner task - also uses closure
      const innerHandle = yield* useBackgroundTask(function* () {
        events.push('inner start')
        
        // Inner task uses same closure reference
        state?.items.push('from-inner')
        yield* sleep(10)
        state?.items.push('from-inner-end')
        events.push('inner end')
      })
      
      // Wait for inner
      yield* innerHandle.waitForDone()
      
      state?.items.push('from-outer-end')
      events.push('outer end')
    })
    
    yield* outerHandle.waitForDone()
    
    // Both tasks should have modified the shared state
    expect(sharedState.items).toEqual([
      'from-outer',
      'from-inner',
      'from-inner-end',
      'from-outer-end'
    ])
    expect(events).toEqual(['outer start', 'inner start', 'inner end', 'outer end'])
  })

  it('should work with contexts option for propagating context', function* () {
    // Alternative pattern: use contexts option
    
    const LoggerContext = createContext<{ debug: (msg: string) => void }>('Logger')
    const logs: string[] = []
    
    const logger = { debug: (msg: string) => logs.push(msg) }
    yield* LoggerContext.set(logger)
    
    const loggerValue = yield* LoggerContext.get()
    
    const handle = yield* useBackgroundTask(function* () {
      // Context is available via contexts option
      const log = yield* LoggerContext.get()
      log?.debug('from background')
    }, {
      contexts: [{ context: LoggerContext, value: loggerValue! }]
    })
    
    yield* handle.waitForDone()
    
    expect(logs).toContain('from background')
  })
})

// =============================================================================
// INTEGRATION TEST: HTTP HANDLER PATTERN
// =============================================================================

describe('HTTP handler pattern integration', () => {
  plainIt('should work in HTTP handler scenario', async () => {
    const events: string[] = []
    const buffer: string[] = []
    
    // Simulate HTTP handler that needs to start background work
    async function httpHandler(): Promise<{ buffer: string[] }> {
      const [handlerScope, destroyHandler] = createScope()
      
      const result = await handlerScope.run(function* () {
        events.push('handler start')
        
        // Start background writer
        const writerHandle = yield* useBackgroundTask(function* () {
          events.push('writer start')
          for (const token of ['hello', 'world', '!']) {
            yield* sleep(10)
            buffer.push(token)
            events.push(`wrote: ${token}`)
          }
          events.push('writer end')
        })
        
        events.push('handler end')
        return { buffer, writerHandle }
      })
      
      events.push('handler scope completed')
      
      // Wait for writer to finish
      const [waitScope, destroyWait] = createScope()
      await waitScope.run(function* () {
        yield* result.writerHandle.waitForDone()
      })
      await destroyWait()
      
      await destroyHandler()
      return { buffer }
    }
    
    const result = await httpHandler()
    
    // Handler should complete quickly
    expect(events).toContain('handler start')
    expect(events).toContain('handler end')
    expect(events).toContain('handler scope completed')
    
    // Writer should have completed
    expect(events).toContain('writer end')
    expect(result.buffer).toEqual(['hello', 'world', '!'])
  })
})
