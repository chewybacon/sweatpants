import type { InteractionBinding } from "@sweatpants/agent-sdk";

export interface SessionMetadata {
  id: string;
  toolName: string;
  elicitBindings: Readonly<Record<string, InteractionBinding>>;
}

/** JSON envelopes keep recursive Cloudflare RPC serialization types bounded. */
export interface ToolSessionRpc {
  start(wire: string): Promise<string>;
  inspect(): Promise<string>;
  next(readerId: string, cursor: number): Promise<string>;
  cancelRead(readerId: string): Promise<void>;
  resume(wire: string): Promise<void>;
  close(): Promise<void>;
}

export interface ToolSessionNamespace {
  getByName(name: string): ToolSessionRpc;
}
