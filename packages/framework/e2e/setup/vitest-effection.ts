/**
 * Vitest + Effection Integration for E2E Tests
 *
 * Enhanced version that supports:
 * - Generator-based test functions
 * - Proper Effection scope management
 * - Resource cleanup on test completion
 * - beforeAll resources shared across tests in a describe block
 *
 * Usage:
 * ```typescript
 * import { describe, it, beforeAll, beforeEach, expect } from './vitest-effection.ts'
 *
 * describe('my test suite', () => {
 *   let server: TestServerHandle
 *
 *   beforeAll(function*() {
 *     server = yield* useTestServer()
 *   })
 *
 *   it('should work', function*() {
 *     const result = yield* someOperation()
 *     expect(result).toBe(42)
 *   })
 * })
 * ```
 */
import {
  describe as $describe,
  it as $it,
  beforeAll as $beforeAll,
  beforeEach as $beforeEach,
  afterAll as $afterAll,
  afterEach as $afterEach,
  expect,
} from 'vitest'
import type { Operation, Scope, Task } from 'effection'
import { run, createScope } from 'effection'

// Re-export expect and vitest utilities
export { expect }

/**
 * Type for test operation functions
 */
export type TestOperation = () => Operation<void>

/**
 * Test adapter that manages Effection scopes per describe block
 */
interface TestAdapter {
  name: string
  parent: TestAdapter | undefined
  scope: Scope | undefined
  destroy: (() => Promise<void>) | undefined
  beforeAllOps: TestOperation[]
  beforeEachOps: TestOperation[]
  afterEachOps: Array<() => void | Promise<void>>
  initialized: boolean
  /** Task running the beforeAll scope - keeps resources alive */
  scopeTask: Task<void> | undefined
}

// Stack of current adapters (for nested describes)
const adapterStack: TestAdapter[] = []

function currentAdapter(): TestAdapter | undefined {
  return adapterStack[adapterStack.length - 1]
}

/**
 * Create a new test adapter for a describe block
 */
function createAdapter(name: string, parent: TestAdapter | undefined): TestAdapter {
  return {
    name,
    parent,
    scope: undefined,
    destroy: undefined,
    beforeAllOps: [],
    beforeEachOps: [],
    afterEachOps: [],
    initialized: false,
    scopeTask: undefined,
  }
}

/**
 * Initialize the adapter's scope (runs beforeAll ops)
 */
async function initAdapter(adapter: TestAdapter): Promise<void> {
  if (adapter.initialized) return

  // Initialize parent first
  if (adapter.parent && !adapter.parent.initialized) {
    await initAdapter(adapter.parent)
  }

  // Create scope
  const [scope, destroy] = createScope()
  adapter.scope = scope
  adapter.destroy = destroy

  // Run beforeAll operations within the scope
  // This keeps any resources created alive until afterAll
  await scope.run(function* () {
    for (const op of adapter.beforeAllOps) {
      yield* op()
    }
  })

  adapter.initialized = true
}

/**
 * Run a test operation with all beforeEach setups
 */
async function runTest(adapter: TestAdapter, op: TestOperation): Promise<void> {
  // Ensure adapter is initialized
  await initAdapter(adapter)

  // Collect all beforeEach ops from ancestors (parent first)
  const allBeforeEach: TestOperation[] = []
  let current: TestAdapter | undefined = adapter
  const ancestors: TestAdapter[] = []
  while (current) {
    ancestors.unshift(current)
    current = current.parent
  }
  for (const a of ancestors) {
    allBeforeEach.push(...a.beforeEachOps)
  }

  // Run in a fresh scope for test isolation
  await run(function* () {
    // Run all beforeEach
    for (const setup of allBeforeEach) {
      yield* setup()
    }
    // Run the test
    yield* op()
  })
}

/**
 * describe() - wraps vitest's describe with Effection scope management
 */
export function describe(name: string, fn: () => void): void {
  const parent = currentAdapter()
  const adapter = createAdapter(name, parent)

  $describe(name, () => {
    // Push adapter onto stack for nested calls
    adapterStack.push(adapter)

    // Set up cleanup
    $afterAll(async () => {
      // Run afterEach cleanup for any remaining state
      for (const cleanup of adapter.afterEachOps) {
        await cleanup()
      }
      // Destroy the Effection scope (cleans up resources)
      if (adapter.destroy) {
        await adapter.destroy()
      }
    })

    // Run the describe body (collects beforeAll, beforeEach, it calls)
    fn()

    // Pop adapter
    adapterStack.pop()
  })
}

// Add skip and only variants
describe.skip = function (name: string, fn: () => void): void {
  $describe.skip(name, fn)
}

describe.only = function (name: string, fn: () => void): void {
  const parent = currentAdapter()
  const adapter = createAdapter(name, parent)

  $describe.only(name, () => {
    adapterStack.push(adapter)
    $afterAll(async () => {
      for (const cleanup of adapter.afterEachOps) {
        await cleanup()
      }
      if (adapter.destroy) {
        await adapter.destroy()
      }
    })
    fn()
    adapterStack.pop()
  })
}

/**
 * it() - wraps vitest's it to run Effection operations
 */
export function it(desc: string, op?: TestOperation): void {
  const adapter = currentAdapter()

  if (!op) {
    // Pending test
    $it.skip(desc, () => {})
    return
  }

  if (!adapter) {
    // No describe block - run standalone
    $it(desc, async () => {
      await run(op)
    })
    return
  }

  $it(desc, async () => {
    await runTest(adapter, op)
  })
}

// Add skip and only variants
it.skip = function (desc: string, _op?: TestOperation): void {
  $it.skip(desc, () => {})
}

it.only = function (desc: string, op: TestOperation): void {
  const adapter = currentAdapter()

  if (!adapter) {
    $it.only(desc, async () => {
      await run(op)
    })
    return
  }

  $it.only(desc, async () => {
    await runTest(adapter, op)
  })
}

/**
 * beforeAll() - run an Effection operation before all tests in the suite
 * Resources created here stay alive until afterAll
 */
export function beforeAll(op: TestOperation): void {
  const adapter = currentAdapter()
  if (adapter) {
    adapter.beforeAllOps.push(op)
  } else {
    // Fallback: just use vitest's beforeAll with run()
    $beforeAll(async () => {
      await run(op)
    })
  }
}

/**
 * beforeEach() - run an Effection operation before each test
 */
export function beforeEach(op: TestOperation): void {
  const adapter = currentAdapter()
  if (adapter) {
    adapter.beforeEachOps.push(op)
  } else {
    // Fallback: just use vitest's beforeEach with run()
    $beforeEach(async () => {
      await run(op)
    })
  }
}

/**
 * afterAll() - cleanup after all tests (regular function, not generator)
 */
export function afterAll(fn: () => void | Promise<void>): void {
  $afterAll(fn)
}

/**
 * afterEach() - cleanup after each test (regular function, not generator)
 */
export function afterEach(fn: () => void | Promise<void>): void {
  const adapter = currentAdapter()
  if (adapter) {
    adapter.afterEachOps.push(fn)
  }
  $afterEach(fn)
}
