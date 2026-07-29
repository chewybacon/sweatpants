import type { Operation } from "effection";
import {
  type RuntimePrimitive,
  type ComponentEmissionPayload,
  type Emission,
  type ComponentTypeLike,
  COMPONENT_EMISSION_TYPE,
  getComponentKey,
} from "./emissions.ts";

export type ApprovalResult = { approved: true } | { approved: false; reason?: string };

export type PermissionType =
  | "geolocation"
  | "clipboard-read"
  | "clipboard-write"
  | "notifications"
  | "camera"
  | "microphone"
  | (string & {});

export interface BaseToolContext {
  callId: string;
  signal: AbortSignal;
  requestApproval(message: string): Operation<ApprovalResult>;
  requestPermission(type: PermissionType): Operation<ApprovalResult>;
  reportProgress(message: string): Operation<void>;
}

export interface BrowserToolContext extends BaseToolContext {
  waitFor<TPayload, TResponse>(type: string, payload: TPayload): Operation<TResponse>;
}

export interface RenderableProps<TResponse> {
  onRespond: (value: TResponse) => void;
  disabled?: boolean;
  response?: TResponse;
}

export type ExtractResponse<TProps> = TProps extends RenderableProps<infer R> ? R : void;
export type UserProps<TProps> = Omit<TProps, keyof RenderableProps<unknown>>;

export interface BrowserRenderContext extends BrowserToolContext {
  render<TProps, TResponse = ExtractResponse<TProps>>(
    Component: ComponentTypeLike<TProps>,
    props: UserProps<TProps>,
  ): Operation<TResponse>;
}

export interface ExecutionState {
  callId: string;
  toolName: string;
  emissions: Emission<ComponentEmissionPayload>[];
  startedAt: number;
  status: "running" | "complete" | "error" | "cancelled";
}

export function createExecutionState(callId: string, toolName: string): ExecutionState {
  return {
    callId,
    toolName,
    emissions: [],
    startedAt: Date.now(),
    status: "running",
  };
}

export interface CreateBrowserContextOptions {
  runtime: RuntimePrimitive;
  callId: string;
  toolName: string;
  executionState?: ExecutionState;
  baseContext?: Partial<BaseToolContext>;
  signal?: AbortSignal;
}

export function createBrowserContext(options: CreateBrowserContextOptions): BrowserRenderContext {
  const {
    runtime,
    callId,
    toolName,
    executionState = createExecutionState(callId, toolName),
    baseContext,
    signal = new AbortController().signal,
  } = options;

  return {
    callId,
    signal,
    requestApproval:
      baseContext?.requestApproval ??
      function* (): Operation<ApprovalResult> {
        return { approved: true };
      },
    requestPermission:
      baseContext?.requestPermission ??
      function* (): Operation<ApprovalResult> {
        return { approved: true };
      },
    reportProgress: baseContext?.reportProgress ?? function* (): Operation<void> {},
    *waitFor<TPayload, TResponse>(type: string, payload: TPayload): Operation<TResponse> {
      return yield* runtime.emit<TPayload, TResponse>(type, payload);
    },
    *render<TProps, TResponse = ExtractResponse<TProps>>(
      Component: ComponentTypeLike<TProps>,
      props: UserProps<TProps>,
    ): Operation<TResponse> {
      const componentKey = getComponentKey(Component);
      const payload: ComponentEmissionPayload = {
        componentKey,
        props: props as Record<string, unknown>,
        _component: Component,
      };
      const response = yield* runtime.emit<ComponentEmissionPayload, TResponse>(
        COMPONENT_EMISSION_TYPE,
        payload,
      );
      executionState.emissions.push({
        id: `${callId}-render-${executionState.emissions.length + 1}`,
        type: COMPONENT_EMISSION_TYPE,
        payload,
        timestamp: Date.now(),
        status: "complete",
        response,
      } as Emission<ComponentEmissionPayload>);
      return response;
    },
  };
}

export type ComponentUserProps<C extends ComponentTypeLike<any>> =
  C extends ComponentTypeLike<infer P> ? UserProps<P> : never;

export type ComponentResponse<C extends ComponentTypeLike<any>> =
  C extends ComponentTypeLike<infer P> ? ExtractResponse<P> : void;
