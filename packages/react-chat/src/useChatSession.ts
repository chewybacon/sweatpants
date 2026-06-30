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
import { run, each } from "effection";
import {
  createChatSession,
  type ChatCommand,
  type ChatSession,
  type ClientToolSessionOptions,
} from "@sweatpants/framework/chat";
import { initialChatState } from "@sweatpants/framework/chat";
import type { TextPart, ReasoningPart } from "@sweatpants/framework/chat";
import { createPipelineTransform, markdown } from "./pipeline/index.ts";
import type {
  ChatState,
  PendingClientToolState,
  ToolEmissionTrackingState,
  ToolEmissionState,
  SessionOptions,
} from "./types.ts";
import type { ElicitTrackingState } from "@sweatpants/framework/chat";
import { useChatConfig } from "./ChatProvider.tsx";
import { createPluginRegistryFrom } from "@sweatpants/framework/chat";
import type { PluginHandleInput } from "@sweatpants/framework/chat";
import { useElicitExecutor } from "./useElicitExecutor.ts";
import type { EmissionPatch } from "@sweatpants/framework/chat";

// =============================================================================
// LOCAL EMISSION STATE REDUCER
// =============================================================================

type LocalEmissionState = Record<string, ToolEmissionTrackingState>;

type LocalEmissionAction = EmissionPatch & { respond?: (response: unknown) => void };

function localEmissionReducer(
  state: LocalEmissionState,
  action: LocalEmissionAction,
): LocalEmissionState {
  switch (action.type) {
    case "tool_emission_start": {
      return {
        ...state,
        [action.callId]: {
          callId: action.callId,
          toolName: action.toolName,
          emissions: [],
          status: "running",
          startedAt: Date.now(),
        },
      };
    }
    case "tool_emission": {
      let tracking = state[action.callId];

      // Auto-create tracking if tool_emission_start hasn't been processed yet
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
          emissions: [...tracking.emissions, newEmission],
        },
      };
    }
    case "tool_emission_response": {
      const tracking = state[action.callId];
      if (!tracking) return state;

      return {
        ...state,
        [action.callId]: {
          ...tracking,
          emissions: tracking.emissions.map((e) => {
            if (e.status === "complete") return e;
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
    case "tool_emission_complete": {
      const tracking = state[action.callId];
      if (!tracking) return state;

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
  /** Current session capabilities */
  capabilities: ChatState["capabilities"];

  // --- Client Tool Approval API ---

  /**
   * Pending client tools awaiting approval.
   *
   * Array of tools that need user approval before execution.
   * Use `approve()` or `deny()` to respond.
   */
  pendingApprovals: PendingClientToolState[];

  /**
   * Approve a pending client tool.
   *
   * @param callId - The tool call ID to approve
   */
  approve: (callId: string) => void;

  /**
   * Deny a pending client tool.
   *
   * @param callId - The tool call ID to deny
   * @param reason - Optional reason for denial
   */
  deny: (callId: string, reason?: string) => void;

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
  const mergedOptions: ClientToolSessionOptions = {
    ...options,
    baseUrl: options.baseUrl ?? config.baseUrl,
    transforms: options.transforms ?? defaultTransforms,
  };

  const sessionIdentity = useMemo(
    () =>
      JSON.stringify({
        baseUrl: mergedOptions.baseUrl,
        conversationId: mergedOptions.conversationId ?? null,
        toolNames: (mergedOptions.tools ?? []).map((tool) =>
          // Canonical tool values carry a `name`.
          (typeof tool === "function" || (typeof tool === "object" && tool !== null)) && "name" in tool
            ? String((tool as { name: unknown }).name)
            : "unknown",
        ),
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

  // Stable ref to options to avoid re-running effect if object identity changes
  const optionsRef = useRef(mergedOptions);
  useEffect(() => {
    optionsRef.current = mergedOptions;
  }, [mergedOptions]);

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
        if (e.message !== "halted") console.error(e);
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
      dispatchCommand({ type: "send", content });
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
    dispatchCommand({ type: "reset" });
  }, [dispatchCommand]);

  // Client tool approval callbacks are retained as no-ops for older callers.
  const approve = useCallback((_callId: string) => {}, []);

  const deny = useCallback((_callId: string, _reason?: string) => {}, []);

  // Get pending approvals from state
  const pendingApprovals = Object.values(state.pendingClientTools).filter(
    (tool) => tool.state === "awaiting_approval",
  );

  // Tool emissions come from both:
  // 1. state.toolEmissions - replay/projection from the stream
  // 2. localEmissions - plugin handlers via ctx.render() (client-side, via useElicitExecutor)
  // Merge both sources, with local emissions taking precedence (they have respond callbacks)
  const toolEmissions: ToolEmissionTrackingState[] = useMemo(() => {
    const merged: Record<string, ToolEmissionTrackingState> = { ...state.toolEmissions };

    // Overlay local emissions (these have the respond callbacks)
    for (const [callId, tracking] of Object.entries(localEmissions)) {
      merged[callId] = tracking;
    }

    return Object.values(merged);
  }, [state.toolEmissions, localEmissions]);

  // Create state with merged emissions for consumers like deriveMessages
  // This ensures plugin handler emissions are visible alongside other data
  const stateWithMergedEmissions = useMemo(
    () => ({
      ...state,
    }),
    [state],
  );

  // Ref for local emissions (needed in respondToEmission callback)
  const localEmissionsRef = useRef(localEmissions);
  useEffect(() => {
    localEmissionsRef.current = localEmissions;
  }, [localEmissions]);

  // Respond to a pending emission
  // Checks local plugin emissions first, then stream-projected emissions.
  const respondToEmission = useCallback(
    (callId: string, emissionId: string, response: unknown) => {
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
        // The respond callback sends tool_emission_response patch to update state
      }
    },
    [dispatchLocalEmission],
  );

  // Get pending elicits from state (MCP plugin tools)
  const pendingElicits: ElicitTrackingState[] = Object.values(state.pendingElicits);

  // Respond to a pending plugin elicitation (internal - used by useElicitExecutor)
  // This dispatches a command to the session which stores the response
  // and sends it with the next message.
  const respondToElicit = useCallback(
    (
      elicit: { sessionId: string; callId: string; elicitId: string },
      result: { action: "accept" | "decline" | "cancel"; content?: unknown },
    ) => {
      // Dispatch an elicit_response command to the session
      dispatchCommand({
        type: "elicit_response",
        sessionId: elicit.sessionId,
        callId: elicit.callId,
        elicitId: elicit.elicitId,
        result,
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

  // Dispatch emission patches (for plugin executor to forward handler emissions)
  // These go to local React state, not through the session
  const dispatchEmissionPatch = useCallback(
    (patch: EmissionPatch & { respond?: (response: unknown) => void }) => {
      dispatchLocalEmission(patch);
    },
    [],
  );

  // Auto-execute plugin handlers when elicitations arrive
  useElicitExecutor({
    pendingElicits: pendingElicits,
    registry: pluginRegistry,
    dispatchEmissionPatch,
    respondToElicit,
  });

  return {
    state: stateWithMergedEmissions,
    send,
    abort,
    reset,
    capabilities: state.capabilities,
    pendingApprovals,
    approve,
    deny,
    toolEmissions,
    respondToEmission,
  };
}
