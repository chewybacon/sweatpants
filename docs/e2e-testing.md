# E2E Testing Strategy

This document outlines our approach to end-to-end testing, comparing different tools and when to use each.

## Overview

We use a two-tier testing strategy:

| Tier | Tool | Environment | Speed | Use Case |
|------|------|-------------|-------|----------|
| **Component/Integration** | Interactors + Vitest | jsdom | ~300ms for 17 tests | UI behavior, state, rendering |
| **Full E2E** | Playwright | Real browser | ~3s for 7 tests | Real browser behavior, network, LLM integration |

## Interactors with Vitest (jsdom)

**Location:** `apps/yo-chat/src/__tests__/interactors-poc.test.tsx`

[Interactors](https://frontside.com/interactors) provide a clean, declarative API for testing UI components. They run in-process with Vitest using jsdom.

### Syntax

```typescript
import { Button, TextField, Heading } from '@interactors/html'

// Find and verify elements
await Button('Submit').exists()
await Button('Submit').has({ disabled: true })

// Interact with elements
await TextField('Email').fillIn('test@example.com')

// Partial matching
await Heading(including('Welcome')).exists()

// Custom interactors for domain concepts
const ChatMessage = createInteractor<HTMLDivElement>('ChatMessage')
  .selector('.message')
  .locator((el) => el.querySelector('.content')?.textContent ?? '')
  .filters({
    role: (el) => el.getAttribute('data-role'),
  })

await ChatMessage('Hello').has({ role: 'user' })
```

### Setup

```typescript
// In your test file
import { setDocumentResolver, setInteractorTimeout } from '@interactors/html'

beforeEach(() => {
  setDocumentResolver(() => document)
  setInteractorTimeout(3000)
})
```

```typescript
// In vite.config.ts
export default defineConfig({
  test: {
    environment: 'jsdom',
  }
})
```

### When to Use Interactors + jsdom

**Best for:**
- Component behavior testing (button states, form validation)
- Rendering logic (message lists, UI state)
- Custom interactor definitions for design systems
- Fast feedback during development
- Testing React components in isolation

**Advantages:**
- Very fast (~20ms per test)
- Excellent error messages with filter mismatch details
- Clean, declarative API
- Based on Effection (structured concurrency)
- Custom interactors for domain concepts

**Limitations:**
- No real browser (CSS, layout, scroll behavior differ)
- Click events less reliable than real browsers
- Components with hooks may fail due to React duplication in monorepos
- No network, navigation, or browser APIs

### Example Error Message

Interactors provide exceptional error messages:

```
did not find Button "Stop", did you mean one of:

┃ Button   ┃ visible: true ┃ disabled: false ┃
┣━━━━━━━━━━╋━━━━━━━━━━━━━━━╋━━━━━━━━━━━━━━━━━┫
┃ ✓ "Stop" ┃ ✓ true        ┃ ⨯ true          ┃
```

## Playwright (Real Browser)

**Location:** `apps/yo-chat/e2e/`

Playwright runs tests in real browsers, providing the most realistic testing environment.

### Native Playwright Syntax

```typescript
import { test, expect } from '@playwright/test'

test('form submission', async ({ page }) => {
  await page.goto('/demo/chat/')
  
  // Find elements
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled()
  
  // Interact
  await page.getByPlaceholder('Type a message...').fill('Hello')
  
  // Verify
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled()
})
```

### Interactor-Style Wrapper for Playwright

We created a thin wrapper that provides Interactor-like syntax while using Playwright under the hood.

**Location:** `apps/yo-chat/e2e/lib/with-playwright.ts`

```typescript
import { interactor, including } from './lib/with-playwright'

test('form submission', async ({ page }) => {
  const I = interactor(page)
  
  await I.Heading('Chat').exists()
  await I.Button('Send').has({ disabled: true })
  await I.TextField('Type a message...').fillIn('Hello')
  await I.Button('Send').has({ disabled: false })
})
```

### When to Use Playwright

**Best for:**
- Full user journey testing
- LLM integration tests (real API calls)
- Visual regression testing
- Cross-browser testing
- Network behavior (streaming, SSE)
- Testing with real browser APIs

**Advantages:**
- Real browser environment
- Screenshots, video, traces
- Network interception
- Multiple browser support
- Reliable event handling

**Limitations:**
- Slower than jsdom (~500ms+ per test)
- Requires browser installation
- More complex CI setup
- Verbose syntax (unless using wrapper)

## Comparison

### API Syntax

```typescript
// Interactors (jsdom)
await Button('Submit').has({ disabled: true })

// Playwright (native)
await expect(page.getByRole('button', { name: 'Submit' })).toBeDisabled()

// Playwright (with wrapper)
await I.Button('Submit').has({ disabled: true })
```

### Test Characteristics

| Aspect | Interactors + jsdom | Playwright |
|--------|---------------------|------------|
| Speed | ~15-30ms/test | ~300-500ms/test |
| Browser | Simulated (jsdom) | Real (Chromium, Firefox, WebKit) |
| CSS/Layout | Limited | Full support |
| Network | Mocked | Real or intercepted |
| Debugging | Node debugger | Browser DevTools, traces |
| CI Complexity | Low | Medium |
| Click Events | Less reliable | Fully reliable |
| React Hooks | May need config | Works out of box |

## Decision Guide

### Use Interactors + jsdom when:

1. **Testing component behavior** - Button enables when form is valid
2. **Testing rendering logic** - Messages appear in correct order
3. **Building design systems** - Create reusable interactors for components
4. **Fast TDD cycles** - Instant feedback during development
5. **Simple UI interactions** - Form fills, button clicks, text verification

### Use Playwright when:

1. **Testing LLM integration** - Real streaming responses
2. **Testing network behavior** - SSE, WebSockets, file uploads
3. **Visual testing** - Screenshots, layout verification
4. **Cross-browser testing** - Chrome, Firefox, Safari
5. **Complex interactions** - Drag-drop, multi-step workflows
6. **Testing with real services** - Ollama, external APIs

### Use Both when:

1. **Component + Integration** - Fast unit tests + slower E2E verification
2. **High-confidence coverage** - jsdom catches most bugs, Playwright catches browser-specific issues

## File Structure

```
apps/yo-chat/
├── src/
│   └── __tests__/
│       └── interactors-poc.test.tsx  # Interactors + Vitest
├── e2e/
│   ├── lib/
│   │   └── with-playwright.ts        # Interactor-style wrapper
│   ├── interactors-playwright.spec.ts
│   ├── markdown-persistence.spec.ts
│   ├── math-assistant.spec.ts
│   └── pick-card.spec.ts
├── vite.config.ts                    # test.environment: 'jsdom'
└── playwright.config.ts
```

## Running Tests

```bash
# Interactors + Vitest (fast)
cd apps/yo-chat && pnpm exec vitest run src/__tests__/

# Playwright (full browser)
cd apps/yo-chat && pnpm exec playwright test

# Specific Playwright test
cd apps/yo-chat && pnpm exec playwright test interactors-playwright.spec.ts --reporter=list
```

## Key Learnings

### 1. Interactors Excel at Component Testing

The clean API and excellent error messages make Interactors ideal for testing UI behavior without the overhead of a real browser.

### 2. Playwright is Essential for Real Integration

LLM streaming, network behavior, and browser-specific features require Playwright. No jsdom simulation can replace testing against Ollama.

### 3. Wrapper API Provides Best of Both Worlds

The `interactor(page)` wrapper gives Playwright tests a cleaner syntax while maintaining full browser capabilities.

### 4. Wait for Ready State

Both tools need proper synchronization. In Playwright, always wait for "Pipeline ready" before interacting with React state:

```typescript
await I.HTML('Pipeline ready').exists({ timeout: 10000 })
```

### 5. Error Messages Matter

Interactors' table-based error messages immediately show why a match failed. This accelerates debugging significantly compared to generic "element not found" errors.

## Future Considerations

1. **Shared Interactor Definitions** - Define custom interactors once, use in both Vitest and Playwright tests
2. **Visual Regression** - Add Playwright screenshot comparisons for UI consistency
3. **Network Mocking** - Use Playwright's route interception for deterministic LLM response testing
4. **Parallel Test Runs** - Playwright's parallelization for faster CI
