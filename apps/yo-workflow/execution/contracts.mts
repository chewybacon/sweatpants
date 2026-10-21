import type {
  BindingContract,
  BindingDeclaration,
  WorkflowExport,
} from "@sweatpants/flowmode-runtime";
import { ANY_JSON_SCHEMA_DESCRIPTOR as schema } from "@sweatpants/durable-execution";

// Explicit contracts for this permissive MVP. These are host declarations, not inferred types.
export const reviewContract: BindingContract = {
  id: "review_draft",
  name: "review_draft",
  description: "Review a draft and release its reservation during cleanup",
  inputSchema: schema,
  outputSchema: schema,
};
export const callerContract: BindingContract = {
  id: "workflow",
  name: "workflow",
  description: "Compose review and announcement",
  inputSchema: schema,
  outputSchema: schema,
};
export const reviewExports: readonly WorkflowExport[] = [
  { name: "reviewDraft", entry: "review_draft", contract: reviewContract },
];
export const reviewImports: readonly BindingDeclaration[] = ["approval", "cleanup"].map((key) => ({
  kind: "host",
  contract: {
    id: JSON.stringify(["elicit", key]),
    name: key,
    description: `Request ${key}`,
    inputSchema: schema,
    outputSchema: schema,
  },
}));
