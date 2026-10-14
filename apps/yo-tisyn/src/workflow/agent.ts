import { createSchemeTool } from "./scheme/tool.ts";
import { createSessionTool } from "./session.ts";
import {
  documentCreate,
  documentRead,
  documentEdit,
  presentChoices,
  displayDocument,
} from "./tools/documents.ts";
import { decisionBinding } from "./decisions.ts";
import type { ToolExposurePolicy } from "@sweatpants/chat-core";
import { createTisynTool, type BoundTool } from "./tisyn.ts";
import { echo } from "./tools/echo.ts";
import { ask } from "./tools/ask.ts";
const primitives: readonly BoundTool[] = [
  echo,
  ask,
  documentCreate,
  documentRead,
  documentEdit,
  presentChoices,
  displayDocument,
];
export const session = createSessionTool(primitives);
export const boundTools: readonly BoundTool[] = [...primitives, session];
export const tisyn = createTisynTool(boundTools).samples().decisions(decisionBinding).build();
export const scheme = createSchemeTool(primitives);
export const programs: readonly BoundTool[] = [scheme, tisyn, ...boundTools];
export function workflowExposureFor(language: "scheme" | "tisyn"): ToolExposurePolicy {
  return {
    *filter({ entries }) {
      if (!entries) throw new Error("Workflow authoring requires an installed tool inventory");
      return entries
        .filter((entry) => entry.definition.name === language)
        .map((entry) => entry.definition);
    },
  };
}
export const workflowExposure = workflowExposureFor("scheme");
