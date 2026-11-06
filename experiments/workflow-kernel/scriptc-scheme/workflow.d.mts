import type {
  TypeScriptWorkflowInput,
  TypeScriptWorkflowFrontend,
} from "../../../packages/v2/codemode-compiler-frontend-typescript/src/index.ts";
export const input: TypeScriptWorkflowInput;
export const frontend: TypeScriptWorkflowFrontend<never>;
export const authored: string;
export const helper: string;
export const debug: {
  sites: Record<
    string,
    { sourceId?: string; line: number; column: number; key?: string; operation: string }
  >;
};
export function admitWorkflow(
  text: string,
  helper: string,
  definitions?: Record<string, { id: string; context?: unknown; response?: unknown }>,
): { source: string; sites: Record<string, unknown> };
export function decodeRequest(boundary: { site: string; value: unknown }): {
  effect: string;
  input: unknown;
};

export { bindEffectBoundary } from "./boundary.mts";
export { authoringGuide } from "./macros.mts";
