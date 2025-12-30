# Refactor Plan: Effection Chat

## Goal
Decouple React state logic from Effection runtime to improve testability, maintainability, and correctly handle Effection resources.

## New File Structure

### 1. `apps/dynobase/src/demo/effection/chat/state.ts` (NEW)
**Responsibility**: Pure logic for state transitions. No side effects.
- **Extracts**:
    - `ChatState` interface
    - `initialChatState`
    - `chatReducer(state: ChatState, patch: ChatPatch): ChatState` (was `applyPatch`)
    - `commitActiveStep` helper
    - `consolidateSteps` helper

### 2. `apps/dynobase/src/demo/effection/chat/session.ts` (REFACTOR)
**Responsibility**: The Effection "Backend". Manages the lifecycle, resources, and main loop.
- **Change**: Replace `runChatSession` with `createChatSession`.
- **API**:
  ```typescript
  export function createChatSession(options: SessionOptions): Resource<ChatSessionAPI>

  export interface ChatSessionAPI {
    state: Stream<ChatState>; // Stream of full state snapshots
    dispatch: (command: ChatCommand) => void; // Signal sender
  }
  ```
- **Internal Logic**:
    - Create `commands` Signal.
    - Create `patches` Channel.
    - Create `states` Channel (to broadcast state updates).
    - Spawn `runCommandLoop` (handles `commands` -> `patches`).
    - Spawn `runStateLoop` (handles `patches` -> `reducer` -> `states`).
    - Provide the API.

### 3. `apps/dynobase/src/demo/effection/chat/useChatSession.ts` (REFACTOR)
**Responsibility**: React Adapter. Connects the Resource to React state.
- **Change**: Reduce to a thin hook.
- **Logic**:
  ```typescript
  export function useChatSession(options) {
    const [state, setState] = useState(initialChatState);
    const apiRef = useRef<ChatSessionAPI>();

    useEffect(() => {
      const task = run(function*() {
        // 1. Start session resource
        const api = yield* createChatSession(options);
        apiRef.current = api;

        // 2. Subscribe to state updates
        for (const nextState of yield* each(api.state)) {
           setState(nextState);
           yield* each.next();
        }
      });

      // 3. Cleanup with correct Future handling
      return () => {
        void task.halt().catch(e => {
             if (e.message !== 'halted') console.error(e);
        });
      };
    }, [options]);

    // Helpers just delegate to apiRef.current.dispatch(...)
    // ...
  }
  ```

## Recommended Plan

1.  **Create `state.ts`**: Move all state definitions and reducer logic.
    -   *Verification*: Run existing tests (they will break, need to update imports temporarily or ignore).
    -   *Better*: Create `state.test.ts` immediately to verify the reducer in isolation.
2.  **Refactor `session.ts`**: Implement the Resource pattern.
    -   Keep `runChatSession` as an internal helper if needed, or inline it.
    -   Ensure the `stateLoop` correctly processes patches.
3.  **Update `useChatSession.ts`**: Rewrite to use the new Resource API.
4.  **Update Tests**:
    -   `session-e2e.test.ts`: Update to consume the new `createChatSession` resource instead of calling `runChatSession`.

## Unit Tests to Add

### `state.test.ts` (New)
Test the reducer logic in isolation.
- `it('should handle streaming_start')` -> verifies state reset.
- `it('should accumulate streaming_text')` -> verifies partial text.
- `it('should consolidate steps on assistant_message')` -> verifies final message structure.
- `it('should handle tool_call_start')` -> verifies step transition.

### `session-resource.test.ts` (Update/New)
Test the Resource lifecycle.
- `it('should provide initial state immediately')`
- `it('should update state on command')`
- `it('should clean up resources on halt')`
