import { createSchemeTool } from "./scheme/tool.ts";
import {
  documentCreate,
  documentRead,
  documentEdit,
  presentChoices,
  displayDocument,
} from "./tools/documents.ts";
import type { ToolExposurePolicy } from "@sweatpants/chat-core";
import type { BoundTool } from "./bound-tool.ts";
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
export const scheme = createSchemeTool(primitives);
export const programs: readonly BoundTool[] = [scheme, ...primitives];
export const workflowExposure: ToolExposurePolicy = {
  *filter({ entries }) {
    if (!entries) {
      throw new Error("Workflow authoring requires an installed tool inventory");
    }
    return entries
      .filter((entry) => entry.definition.name === "scheme")
      .map((entry) => entry.definition);
  },
};
