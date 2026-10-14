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
export const programs: readonly BoundTool[] = [tisyn, ...boundTools];
export const tisynExposure: ToolExposurePolicy = {
  *filter({ entries }) {
    if (!entries) {
      throw new Error("Tisyn requires an installed tool inventory");
    }
    return entries
      .filter((entry) => entry.definition.name === tisyn.name)
      .map((entry) => entry.definition);
  },
};
