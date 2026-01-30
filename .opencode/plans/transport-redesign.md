# Transport Interface Redesign Plan

## Overview

This document outlines the plan to redesign the Transport interface to support bidirectional communication where `send()` returns a sub-transport for receiving progress and results.

## Motivation

The current Transport interface:

```typescript
interface Transport<TSend, TReceive> extends Stream<TReceive, void> {
  send(message: TSend): Operation<void>;
}
```

Has limitations:
1. `send()` is fire-and-forget — no way to receive responses
2. Correlation must be implemented as a separate layer (`CorrelatedTransport`)
3. No support for nested conversations (e.g., wizard validation flow)

The goal is to make Transport a "long cross-boundary coroutine" where both sides can exchange messages until one side closes with a final value.

---

## Core Design

### New Transport Interface

```typescript
interface Transport<TSend, TReceive, TClose, TReply = Operation<void>> 
  extends Stream<TReceive, TClose> {
  send(message: TSend): TReply;
}
```

**Type Parameters:**
- `TSend` — What this side sends
- `TReceive` — What this side receives (via Stream subscription)
- `TClose` — What the Stream closes with (the "response" type)
- `TReply` — What `send()` returns (another Transport for sub-conversations, or `Operation<void>` for fire-and-forget)

**Key Insight:** Since `Transport` extends `Stream`, and `Stream` has a `close(value: TClose)` method, closing the conversation with a value is built-in.

---

## Wizard Validation Flow — ASCII Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        WIZARD VALIDATION FLOW                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   PRINCIPAL (Agent)                         OPERATIVE (UI)                  │
│   ─────────────────                         ──────────────                  │
│                                                                             │
│   ┌─────────────────┐                       ┌─────────────────┐             │
│   │ transport.send  │ ──── ElicitRequest ───>│ receives request│             │
│   │ (wizard elicit) │                       │ as RequestChannel│            │
│   └────────┬────────┘                       └────────┬────────┘             │
│            │                                         │                      │
│            │ gets ResponseChannel                    │                      │
│            v                                         v                      │
│   ┌─────────────────┐                       ┌─────────────────┐             │
│   │ forEach(channel)│                       │ User fills      │             │
│   │ waiting...      │                       │ wizard page 1   │             │
│   └────────┬────────┘                       └────────┬────────┘             │
│            │                                         │                      │
│            │         ┌───────────────────────────────┘                      │
│            │         │                                                      │
│            │         v                                                      │
│            │  ┌──────────────────┐                                          │
│            │  │ request.send     │                                          │
│            │  │ {validation-needed}                                         │
│            │  └────────┬─────────┘                                          │
│            │           │                                                    │
│            <───────────┘ WizardProgress                                     │
│            │                                                                │
│   ┌────────v────────┐                                                       │
│   │ Received:       │                                                       │
│   │ validation-needed                                                       │
│   │                 │                       ┌─────────────────┐             │
│   │ channel.send    │ ─ ValidationProgress ─>│ forEach(request)│             │
│   │ {validating}    │                       │ showSpinner()   │             │
│   │                 │                       └────────┬────────┘             │
│   │ channel.send    │ ─ ValidationProgress ─>         │                      │
│   │ {checking-inv}  │                       showSpinner()                   │
│   │                 │                                │                      │
│   │ channel.send    │ ─ ValidationProgress ─>         │                      │
│   │ {checking-pay}  │                       showSpinner()                   │
│   │                 │                                │                      │
│   │ channel.send    │ ─ ValidationProgress ─>         │                      │
│   │ {valid}         │                       ─────────┘                      │
│   └────────┬────────┘                                                       │
│            │                                         │                      │
│            │                                         v                      │
│            │                                ┌─────────────────┐             │
│            │                                │ Validation OK!  │             │
│            │                                │ request.send    │             │
│            │                                │ {page-complete} │             │
│            │                                └────────┬────────┘             │
│            │                                         │                      │
│            <─────────────────────────────────────────┘ WizardProgress       │
│            │                                                                │
│   ┌────────v────────┐                       ┌─────────────────┐             │
│   │ Received:       │                       │ User fills      │             │
│   │ page-complete   │                       │ wizard page 2   │             │
│   │ waiting...      │                       │ ...             │             │
│   └────────┬────────┘                       └────────┬────────┘             │
│            │                                         │                      │
│            │         (repeat for each page)          │                      │
│            │                                         │                      │
│            │                                         v                      │
│            │                                ┌─────────────────┐             │
│            │                                │ request.close   │             │
│            │                                │ {accepted, data}│             │
│            │                                └────────┬────────┘             │
│            │                                         │                      │
│            <─────────────────────────────────────────┘ ElicitResponse       │
│            │                                         (stream closes)        │
│   ┌────────v────────┐                                                       │
│   │ forEach returns │                                                       │
│   │ ElicitResponse  │                                                       │
│   │ {accepted, data}│                                                       │
│   └─────────────────┘                                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

LEGEND:
  ────>  Message sent (TSend)
  <────  Message received (TReceive) 
  TClose returned when stream closes (forEach return value)
```

---

## Stream Iteration Patterns

### Using `forEach` from `@effectionx/stream-helpers`

The `forEach` helper iterates a stream and returns the close value:

```typescript
import { forEach } from "@effectionx/stream-helpers";

function* forEach<T, TClose>(
  fn: (item: T) => Operation<void>,
  stream: Stream<T, TClose>,
): Operation<TClose>
```

### When to Use `forEach`

**Use `forEach` for one-directional consumption:**
- Principal receiving progress and waiting for response
- Operative receiving requests (outer loop)
- Any case where you only need to react to received messages

```typescript
// Principal: send request, consume progress, get response
const response: ElicitResponse = yield* forEach(function* (progress) {
  console.log("Progress:", progress);
}, channel);
```

**Use manual loop for bidirectional interleaving:**
- When you need to send messages based on what you receive
- Wizard validation where operative sends AND receives

```typescript
// Operative: interleave send/receive
const sub = yield* request;
let result = yield* sub.next();
while (!result.done) {
  if (result.value.status === "checking") {
    yield* request.send({ status: "waiting" });
  }
  result = yield* sub.next();
}
```

---

## Usage Examples

### Simple Request-Response (Principal with `forEach`)

```typescript
import { forEach } from "@effectionx/stream-helpers";

function* principal(transport: PrincipalTransport<ElicitRequest, ElicitProgress, ElicitResponse>) {
  // Send request, get response channel
  const channel = yield* transport.send({ 
    id: "1", 
    kind: "elicit", 
    type: "form", 
    payload: { fields: [...] } 
  });
  
  // forEach returns ElicitResponse when stream closes
  const response: ElicitResponse = yield* forEach(function* (progress) {
    console.log("Progress:", progress);
    updateUI(progress);
  }, channel);
  
  console.log("Final response:", response);
  return response;
}
```

### Simple Request-Response (Operative with `forEach`)

```typescript
import { forEach } from "@effectionx/stream-helpers";

function* operative(transport: OperativeTransport<unknown, ElicitProgress, ElicitResponse>) {
  // forEach over incoming requests
  yield* forEach(function* (request) {
    console.log("Got request:", request.id, request.type, request.payload);
    
    // Send progress
    yield* request.send({ status: "processing" });
    yield* request.send({ status: "almost-done" });
    
    // Close with response
    yield* request.close({ status: "accepted", content: { result: "done" } });
  }, transport);
}
```

### Wizard with Validation (Principal — `forEach` works)

```typescript
import { forEach } from "@effectionx/stream-helpers";

function* principalWizard(transport: PrincipalTransport<...>) {
  const channel = yield* transport.send({ 
    id: "1", 
    kind: "elicit", 
    type: "wizard", 
    payload: { pages: [...] } 
  });
  
  // Principal only receives progress and sends validation
  // forEach works because we send in response to receives
  const response: ElicitResponse = yield* forEach(function* (progress) {
    if (progress.status === "validation-needed") {
      // Send validation progress to operative
      yield* channel.send({ status: "validating", step: progress.page });
      yield* channel.send({ status: "checking-inventory" });
      yield* channel.send({ status: "checking-payment" });
      yield* channel.send({ status: "valid" });
    }
    
    if (progress.status === "page-complete") {
      console.log(`Page ${progress.page} done`);
    }
  }, channel);
  
  return response;
}
```

### Wizard with Validation (Operative — Manual Loop Required)

```typescript
import { forEach } from "@effectionx/stream-helpers";

function* operativeWizard(transport: OperativeTransport<...>) {
  yield* forEach(function* (request) {
    // Subscribe to principal's validation messages
    const principalSub = yield* request;
    
    for (const page of request.payload.pages) {
      // User fills out page
      const formData = yield* waitForUserInput(page);
      
      // Request validation from principal
      yield* request.send({ 
        status: "validation-needed", 
        page: page.id, 
        data: formData 
      });
      
      // Manual loop: receive validation progress, interleave with UI updates
      let valResult = yield* principalSub.next();
      while (!valResult.done) {
        const validation = valResult.value;
        
        if (validation.status === "valid") {
          break; // Validation passed, proceed
        } else if (validation.status === "invalid") {
          showErrors(validation.errors);
          // User fixes, re-request validation...
          break;
        } else {
          // Show progress: "checking-inventory", "checking-payment", etc.
          showSpinner(validation.status);
        }
        
        valResult = yield* principalSub.next();
      }
      
      // Page validated, notify principal
      yield* request.send({ status: "page-complete", page: page.id });
    }
    
    // Wizard complete
    yield* request.close({ status: "accepted", content: wizardResult });
  }, transport);
}
```

---

## Type Definitions

### RequestChannel (What Operative Receives)

```typescript
interface RequestChannel<TPayload, TProgress, TResponse, TPrincipalProgress = never> 
  extends Transport<
    TProgress,              // Operative sends progress
    TPrincipalProgress,     // Receives from principal (validation, interrupts)
    void,                   // Operative doesn't receive a close value
    Operation<void>         // No deeper nesting by default
  > {
  readonly id: string;
  readonly kind: "elicit" | "notify";
  readonly type: string;
  readonly payload: TPayload;
  
  close(response: TResponse): Operation<void>;
}
```

### ResponseChannel (What Principal Gets Back)

```typescript
type ResponseChannel<TProgress, TResponse, TPrincipalProgress = never> = Transport<
  TPrincipalProgress,       // Principal sends validation/interrupts
  TProgress,                // Receives progress from operative
  TResponse,                // Closes with operative's response
  Operation<void>           // No deeper nesting by default
>;
```

### Top-Level Transports

```typescript
type PrincipalTransport<TRequest, TProgress, TResponse> = Transport<
  TRequest,
  never,                    // Principal receives via sub-channels, not top-level
  void,                     // Connection close (disconnect)
  ResponseChannel<TProgress, TResponse>
>;

type OperativeTransport<TPayload, TProgress, TResponse> = Transport<
  never,                    // Operative sends via request channels, not top-level
  RequestChannel<TPayload, TProgress, TResponse>,
  void,                     // Connection close
  Operation<void>
>;
```

---

## Implementation Plan

### Phase 1: Core Type Changes

**Files to modify:**
- `packages/core/src/types/transport.ts`

**Changes:**
1. Update `Transport` interface to add `TClose` and `TReply` type parameters
2. Define `RequestChannel` interface
3. Define `ResponseChannel` type
4. Update `PrincipalTransport` and `OperativeTransport` type aliases

### Phase 2: Transport Implementations

**Files to modify:**
- `packages/core/src/transport/pair.ts` (in-memory transport pair)
- `packages/core/src/transport/websocket/principal.ts`
- `packages/core/src/transport/websocket/operative.ts`
- `packages/core/src/transport/sse/principal.ts`
- `packages/core/src/transport/sse/operative.ts`

**Changes:**
1. Implement `send()` returning a sub-transport (channel scoped to request ID)
2. Implement request-as-transport pattern for operative side
3. Wire up message routing between parent transport and sub-channels

### Phase 3: Remove Correlation Layer

**Files to delete:**
- `packages/core/src/transport/correlation.ts`

**Changes:**
1. Delete the correlation module entirely (correlation is now built into Transport)
2. Update any code that imports from `correlation.ts` to use direct `transport.send()`
3. Remove `CorrelatedTransport` from `packages/core/src/index.ts` exports

### Phase 4: Update Consumers

**Files to modify:**
- `packages/core/src/protocol/serve.ts`
- `packages/core/src/agent/*.ts`
- `packages/core/src/builtins/*.ts`
- Test files

**Changes:**
1. Update to use new Transport API
2. Replace `CorrelatedTransport` usage with direct `transport.send()`

### Phase 5: Tests

**Files to modify:**
- `packages/core/src/transport/__tests__/*.ts`
- `packages/core/src/transport/websocket/__tests__/*.ts`
- `packages/core/src/transport/sse/__tests__/*.ts`

**Changes:**
1. Add tests for nested transport behavior
2. Add tests for request-as-transport pattern
3. Add tests for bidirectional validation flow
4. Update existing tests to new API

---

## Open Questions

1. **Should `RequestChannel` extend `Transport` or be a separate interface?**
   - Pro extending: Reuse, consistency
   - Con extending: `RequestChannel` has extra properties (`id`, `payload`, etc.)
   - Current recommendation: Extend Transport, add properties via intersection

2. **How deep should nesting go?**
   - Current plan: One level of bidirectional communication (principal <-> operative progress)
   - Future: Could add `TReply` to `ResponseChannel`/`RequestChannel` for deeper nesting

3. **What about cancellation/interrupts?**
   - The Stream close mechanism handles this
   - Could add explicit `cancel()` method or use a sentinel close value

4. **Wire protocol changes?**
   - Current wire protocol (progress/response messages with IDs) should work
   - May need to add message types for principal->operative progress

---

## Migration Strategy

1. **Non-breaking first:** Add `TClose` and `TReply` with defaults that preserve current behavior
2. **Implement new transports:** Create new transport implementations alongside existing ones
3. **Gradual migration:** Update consumers one at a time
4. **Remove correlation:** Delete `packages/core/src/transport/correlation.ts` and update imports

---

## Summary

The redesigned Transport interface:
- Makes `send()` return a sub-transport for the conversation
- Builds correlation into the type system (no separate layer needed)
- Supports bidirectional communication (wizard validation flow)
- Uses existing Stream/Channel close mechanism for responses
- Is composable for deeper nesting if needed

The key insight is that a Transport is a "long cross-boundary coroutine" where both sides can exchange messages, and nesting transports creates a stack of such coroutines (like Russian dolls).
