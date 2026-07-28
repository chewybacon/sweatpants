/**
 * lib/chat/registry-types.ts
 *
 * Shared registry interface extracted to break the cross-boundary cycle:
 *   handler/durable/types.ts → lib/chat/index.ts → contexts.ts → handler/durable/types.ts
 *
 * contexts.ts now imports McpToolRegistry from this leaf module instead of
 * from handler/durable/types.ts, removing the back-edge.
 */

export interface McpToolRegistry {
  get(name: string): unknown | undefined;
  has(name: string): boolean;
  names(): string[];
}
