/**
 * useChatSession.ts
 *
 * React hook that bridges React state <-> Effection session runtime.
 *
 * ## Architecture
 *
 * This hook is a thin adapter around the `createChatSession` resource.
 * It manages:
 * 1. Mounting/unmounting the Effection session
 * 2. Syncing session state to React state
 * 3. Exposing dispatch methods (send, abort, reset)
 */
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { ElicitExchangeCompletion } from "@sweatpants/agent-sdk";
import { run, each } from "effection";
import { z } from "zod";
import {
  createChatSession,
  initialChatState,
  type ChatCommand,
  type ChatSession,
  type ElicitTrackingState,
  type LocalEmissionAction as FrameworkLocalEmissionAction,
  type ReasoningPart,
  type TextPart,
} from "@sweatpants/chat-core";
import { createPluginRegistryFrom, type PluginHandleInput } from "@sweatpants/tool-session/mcp";
import { createPipelineTransform, markdown } from "./pipeline/index.ts";
import type {
  ChatState,
  ToolEmissionTrackingState,
  ToolEmissionState,
  SessionOptions,
} from "./types.ts";
import type { ToolExecutionTrace } from "@sweatpants/chat-core";
import { useChatConfig } from "./ChatProvider.tsx";
import { useElicitExecutor } from "./useElicitExecutor.ts";

/**
 * Authored `tools` entries are `unknown[]`; both function and object tool
 * values carry a `name`. The parser only proves that carrier shape.
 */
const namedToolSchema = z.custom<{ name: unknown }>(
  (value) =>
    (typeof value === "function" || (typeof value === "object" && value !== null)) &&
    "name" in (value as object),
);

// =============================================================================
// LOCAL EMISSION STATE REDUCER
// =============================================================================

type LocalEmissionState = Record<string, ToolEmissionTrackingState>;

type LocalEmissionAction = FrameworkLocalEmissionAction;

function localEmissionReducer(
  state: LocalEmissionState,
  action: LocalEmissionAction,
): LocalEmissionState {
  switch (action.type) {
    case "EMISSION_STARTED": {
      const existing = state[action.callId];
      return {
        ...state,
        [action.callId]: {
          callId: action.callId,
          toolName: action.toolName,
          emissions: existing?.emissions ?? [],
          status: "running",
          startedAt: existing?.startedAt ?? Date.now(),
          ...(existing?.completedAt ? { completedAt: existing.completedAt } : {}),
        },
      };
    }
    case "EMISSION_ADDED": {
      let tracking = state[action.callId];

      // Auto-create tracking if EMISSION_STARTED has not been processed yet
      // This handles React batching race conditions where emissions arrive
      // before the start event is reflected in state
      if (!tracking) {
        tracking = {
          callId: action.callId,
          toolName: action.toolName ?? "unknown",
          emissions: [],
          status: "running" as const,
          startedAt: Date.now(),
        };
      }

      const newEmission: ToolEmissionState = {
        callId: action.callId,
        toolName: tracking.toolName,
        id: action.emission.id,
        type: action.emission.type,
        payload: action.emission.payload,
        status: action.emission.status,
        timestamp: action.emission.timestamp,
        ...(action.emission.response !== undefined && { response: action.emission.response }),
        ...(action.emission.error !== undefined && { error: action.emission.error }),
        ...(action.respond !== undefined && { respond: action.respond }),
      };

      return {
        ...state,
        [action.callId]: {
          ...tracking,
          emissions: [
            ...tracking.emissions.filter((emission) => emission.id !== newEmission.id),
            newEmission,
          ],
        },
      };
    }
    case "EMISSION_RESPONDED": {
      const tracking = state[action.callId];
      if (!tracking) {
        return state;
      }

      return {
        ...state,
        [action.callId]: {
          ...tracking,
          emissions: tracking.emissions.map((e) => {
            if (e.status === "complete") {
              return e;
            }
            // Once any elicitation emission for a tool call receives a response,
            // disable all pending emissions for that call. Historical plugin
            // UIs remain visible but must not stay interactive while the remote
            // tool coroutine advances to sampling or the next elicitation.
            const { respond: _, ...rest } = e;
            return {
              ...rest,
              status: "complete" as const,
              ...(e.id === action.emissionId ? { response: action.response } : {}),
            };
          }),
        },
      };
    }
    case "EMISSION_COMPLETED": {
      const tracking = state[action.callId];
      if (!tracking) {
        return state;
      }

      return {
        ...state,
        [action.callId]: {
          ...tracking,
          status: "complete",
          completedAt: Date.now(),
        },
      };
    }
    default:
      return state;
  }
}

function shouldLocalEmissionWin(
  local: ToolEmissionState,
  durable: ToolEmissionState | undefined,
): boolean {
  return local.respond !== undefined || local.status === "pending" || durable === undefined;
}

function mergeEmissionTracking(
  durable: ToolEmissionTrackingState | undefined,
  local: ToolEmissionTrackingState,
): ToolEmissionTrackingState {
  if (!durable) {
    return local;
  }

  const mergedById = new Map<string, ToolEmissionState>();
  for (const emission of durable.emissions) {
    mergedById.set(emission.id, emission);
  }
  for (const emission of local.emissions) {
    const durableEmission = mergedById.get(emission.id);
    if (shouldLocalEmissionWin(emission, durableEmission)) {
      mergedById.set(emission.id, emission);
    }
  }

  const orderedIds = [
    ...durable.emissions.map((emission) => emission.id),
    ...local.emissions.map((emission) => emission.id),
  ];
  const seen = new Set<string>();
  const emissions: ToolEmissionState[] = [];
  for (const id of orderedIds) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const emission = mergedById.get(id);
    if (emission) {
      emissions.push(emission);
    }
  }

  return {
    ...durable,
    status: local.status === "running" ? "running" : durable.status,
    emissions,
  };
}

/** Default transforms applied to all sessions */
const defaultTransforms = [createPipelineTransform({ processors: [markdown] })];

/**
 * Options for useChatSession hook.
 */
export interface UseChatSessionOptions extends SessionOptions {
  /**
   * Plugin handles for MCP tool elicitation handling.
   *
   * Pass concrete plugin objects (the return value of
   * `makePlugin(tool).onElicit({...}).build()`). The framework extracts
   * `plugin.client` for client-side elicitation handler registration and
   * derives the server-side `enabledPlugins` list from `plugin.client.toolName`.
   *
   * The old `.client` registration and `enabledPlugins` string array are no
   * longer accepted.
   *
   * @example
   * ```tsx
   * import { bookFlightPlugin } from './tools/book-flight/plugin'
   *
   * const { messages, send } = useChatSession({
   *   plugins: [bookFlightPlugin],
   * })
   * // That's it! Plugin emissions render automatically via toolEmissions.
   * ```
   */
  plugins?: PluginHandleInput[];
}

export interface UseChatSessionReturn {
  /** Current session state */
  state: ChatState;
  /** Send a message */
  send: (content: string) => void;
  /** Abort current streaming */
  abort: () => void;
  /** Reset the session */
  reset: () => void;
  // --- Tool Emissions API (ctx.render() pattern) ---

  /**
   * Active tool emissions from tools using the new ctx.render() pattern.
   *
   * Each entry tracks all emissions for a tool call including their status.
   * Emissions with `status: 'pending'` need user interaction before the tool can continue.
   *
   * @example
   * ```tsx
   * // Render pending emissions
   * {toolEmissions.map(tracking => (
   *   tracking.emissions.filter(e => e.status === 'pending').map(emission => {
   *     const Component = emission.payload._component
   *     return (
   *       <Component
   *         key={emission.id}
   *         {...emission.payload.props}
   *         onRespond={(value) => respondToEmission(emission.callId, emission.id, value)}
   *         disabled={false}
   *       />
   *     )
   *   })
   * ))}
   * ```
   */
  toolEmissions: ToolEmissionTrackingState[];

  /**
   * Respond to a pending emission with user input.
   *
   * Call this when the user completes interaction with an emission's UI.
   * This resumes the tool's execution with the response value.
   *
   * @param callId - The tool call ID
   * @param emissionId - The emission ID
   * @param response - The response value (type depends on component)
   */
  respondToEmission: (callId: string, emissionId: string, response: unknown) => void;
}

/**
 * Hook that provides an Effection-powered chat session.
 *
 * The session runtime runs as a long-lived Effection task.
 * Commands are sent via Signal, state updates come via Channel.
 *
 * @param options - Session configuration options
 */
export function useChatSession(options: UseChatSessionOptions = {}): UseChatSessionReturn {
  const config = useChatConfig();
  const [state, setState] = useState<ChatState>(initialChatState);

  // Local state for plugin emissions (handled React-side, not through session)
  // Using useState with functional updates for better async compatibility
  const [localEmissions, setLocalEmissions] = useState<LocalEmissionState>({});

  const dispatchLocalEmission = useCallback((action: LocalEmissionAction) => {
    setLocalEmissions((prev) => localEmissionReducer(prev, action));
  }, []);

  // Ref to access current state in callbacks without re-creating them
  const stateRef = useRef<ChatState>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Merge default transforms with user-provided transforms
  // Use baseUrl from options if provided, otherwise from context
  const mergedOptions: SessionOptions = {
    ...options,
    baseUrl: options.baseUrl ?? config.baseUrl,
    transforms: options.transforms ?? defaultTransforms,
  };

  const sessionIdentity = useMemo(
    () =>
      JSON.stringify({
        baseUrl: mergedOptions.baseUrl,
        conversationId: mergedOptions.conversationId ?? null,
        toolNames: (mergedOptions.tools ?? []).map((tool) => {
          // Canonical tool values carry a `name`.
          const named = namedToolSchema.safeParse(tool);
          return named.success ? String(named.data.name) : "unknown";
        }),
        pluginNames: (options.plugins ?? []).map((plugin) => plugin.client.toolName),
        transformCount: mergedOptions.transforms?.length ?? 0,
      }),
    [
      mergedOptions.baseUrl,
      mergedOptions.conversationId,
      mergedOptions.tools,
      mergedOptions.transforms,
      options.plugins,
    ],
  );

  useEffect(() => {
    setLocalEmissions({});
  }, [sessionIdentity]);

  // Stable ref to options to avoid re-running the session effect if object identity changes.
  const optionsRef = useRef(mergedOptions);
  optionsRef.current = mergedOptions;

  // Store the dispatch function from the session. Commands sent before
  // Effection finishes mounting are buffered so early user clicks do not no-op.
  const dispatchRef = useRef<ChatSession["dispatch"] | null>(null);
  const pendingCommandsRef = useRef<ChatCommand[]>([]);

  useEffect(() => {
    // Start the Effection runtime
    const task = run(function* () {
      const { state: stateStream, dispatch } = yield* createChatSession(optionsRef.current);

      // Expose dispatch to React and flush commands that arrived during mount.
      dispatchRef.current = dispatch;
      const pendingCommands = pendingCommandsRef.current.splice(0);
      for (const pending of pendingCommands) {
        dispatch(pending);
      }

      // Subscribe to state updates
      for (const s of yield* each(stateStream)) {
        setState(s);
        yield* each.next();
      }
    });

    // Cleanup: halt the task
    return () => {
      dispatchRef.current = null;
      void task.halt().catch((e) => {
        if (e.message !== "halted") {
          console.error(e);
        }
      });
    };
  }, [sessionIdentity]);

  const dispatchCommand = useCallback((command: ChatCommand) => {
    const dispatch = dispatchRef.current;
    if (dispatch) {
      dispatch(command);
      return;
    }
    pendingCommandsRef.current.push(command);
  }, []);

  // Stable command callbacks
  const send = useCallback(
    (content: string) => {
      const streamingText = stateRef.current.streaming.parts
        .filter((part): part is TextPart => part.type === "text")
        .map((part) => part.content)
        .join("");
      dispatchCommand({
        type: "send",
        content,
        ...(stateRef.current.isStreaming && streamingText.trim()
          ? { partialContent: streamingText }
          : {}),
      });
    },
    [dispatchCommand],
  );

  const abort = useCallback(() => {
    const currentState = stateRef.current;

    // In the parts-based model, collect content from streaming parts
    // Concatenate all text and reasoning parts for partial content
    const partialContent = currentState.streaming.parts
      .filter((p): p is TextPart | ReasoningPart => p.type === "text" || p.type === "reasoning")
      .map((p) => p.content)
      .join("");

    dispatchCommand({
      type: "abort",
      partialContent,
    });
  }, [dispatchCommand]);

  const reset = useCallback(() => {
    setLocalEmissions({});
    dispatchCommand({ type: "reset" });
  }, [dispatchCommand]);

  // Tool emissions come from both:
  // 1. state.toolEmissions - replay/projection from the stream
  // 2. localEmissions - plugin handlers via ctx.render() (client-side, via useElicitExecutor)
  // Merge both sources, with local emissions taking precedence (they have respond callbacks)
  const mergedToolEmissions = useMemo(() => {
    const merged: Record<string, ToolEmissionTrackingState> = { ...state.toolEmissions };

    for (const [callId, tracking] of Object.entries(localEmissions)) {
      merged[callId] = mergeEmissionTracking(merged[callId], tracking);
    }

    return merged;
  }, [state.toolEmissions, localEmissions]);

  const toolEmissions: ToolEmissionTrackingState[] = useMemo(
    () => Object.values(mergedToolEmissions),
    [mergedToolEmissions],
  );

  // Create state with merged emissions for consumers like deriveMessages.
  const stateWithMergedEmissions = useMemo(
    () => ({
      ...state,
      toolEmissions: mergedToolEmissions,
    }),
    [state, mergedToolEmissions],
  );

  // Ref for local emissions (needed in respondToEmission callback)
  const localEmissionsRef = useRef(localEmissions);
  useEffect(() => {
    localEmissionsRef.current = localEmissions;
  }, [localEmissions]);

  // Respond to a pending emission
  // Checks local plugin emissions first, then stream-projected emissions.
  const respondToEmission = useCallback((callId: string, emissionId: string, response: unknown) => {
    // Check local emissions first (plugin handlers have priority, they have respond callbacks)
    const localTracking = localEmissionsRef.current[callId];
    const localEmission = localTracking?.emissions.find(
      (e: ToolEmissionState) => e.id === emissionId,
    );
    if (localEmission?.respond) {
      localEmission.respond(response);
      return;
    }

    // Check state emissions from stream replay/projection
    const stateTracking = stateRef.current.toolEmissions[callId];
    const stateEmission = stateTracking?.emissions.find(
      (e: ToolEmissionState) => e.id === emissionId,
    );
    if (stateEmission?.respond) {
      stateEmission.respond(response);
      // The respond callback applies EMISSION_RESPONDED to ephemeral browser state
    }
  }, []);

  // Get pending elicits from state (MCP plugin tools)
  const pendingElicits: ElicitTrackingState[] = Object.values(state.pendingElicits);

  // Respond to a pending plugin elicitation (internal - used by useElicitExecutor)
  // This dispatches a command to the session which stores the response
  // and sends it with the next message.
  const respondToElicit = useCallback(
    (
      elicit: { sessionId: string; callId: string; elicitId: string; toolName?: string },
      result: ElicitExchangeCompletion<unknown>,
      trace?: ToolExecutionTrace,
    ) => {
      // Dispatch an elicit_response command to the session
      dispatchCommand({
        type: "elicit_response",
        sessionId: elicit.sessionId,
        callId: elicit.callId,
        elicitId: elicit.elicitId,
        ...(elicit.toolName ? { toolName: elicit.toolName } : {}),
        completion: result,
        ...(trace ? { trace } : {}),
      });
    },
    [dispatchCommand],
  );

  // Build plugin registry from options. Each entry is a full plugin handle;
  // extract `.client` for client-side elicitation handler registration.
  const pluginRegistry = useMemo(
    () => createPluginRegistryFrom((options.plugins ?? []).map((plugin) => plugin.client)),
    [options.plugins],
  );

  // Apply ephemeral emission actions from the browser plugin executor.
  // These go to local React state, not through the session
  const dispatchLocalEmissionAction = useCallback(
    (action: LocalEmissionAction & { respond?: (response: unknown) => void }) => {
      dispatchLocalEmission(action);
    },
    [dispatchLocalEmission],
  );

  // Auto-execute plugin handlers when elicitations arrive
  useElicitExecutor({
    pendingElicits: pendingElicits,
    registry: pluginRegistry,
    dispatchLocalEmissionAction,
    respondToElicit,
  });

  return {
    state: stateWithMergedEmissions,
    send,
    abort,
    reset,
    toolEmissions,
    respondToEmission,
  };
}
