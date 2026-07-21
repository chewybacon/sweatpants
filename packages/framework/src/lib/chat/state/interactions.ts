import type { ComponentEmissionPayload } from "../browser-rendering/emissions.ts";

export interface ElicitState {
  elicitId: string;
  sessionId: string;
  callId: string;
  toolName: string;
  key: string;
  message: string;
  schema: Record<string, unknown>;
  context?: unknown;
  status: "pending" | "responded" | "cancelled";
  response?: unknown;
  timestamp: number;
}

export interface ElicitTrackingState {
  callId: string;
  toolName: string;
  elicitations: ElicitState[];
  status: "awaiting_elicit" | "complete" | "error" | "cancelled";
  startedAt: number;
}

export interface ToolEmissionState {
  id: string;
  callId: string;
  toolName: string;
  type: string;
  payload: ComponentEmissionPayload;
  status: "pending" | "complete" | "error";
  response?: unknown;
  error?: string;
  timestamp: number;
  respond?: (response: unknown) => void;
}

export interface ToolEmissionTrackingState {
  callId: string;
  toolName: string;
  emissions: ToolEmissionState[];
  status: "running" | "complete" | "error" | "cancelled";
  startedAt: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
}

/** Ephemeral browser-only actions. They never enter the durable AG-UI log. */
export type LocalEmissionAction =
  | { type: "EMISSION_STARTED"; callId: string; toolName: string }
  | {
      type: "EMISSION_ADDED";
      callId: string;
      toolName?: string;
      emission: Omit<ToolEmissionState, "callId" | "toolName">;
      respond?: (response: unknown) => void;
    }
  | { type: "EMISSION_RESPONDED"; callId: string; emissionId: string; response: unknown }
  | { type: "EMISSION_COMPLETED"; callId: string; result?: unknown; error?: string };
