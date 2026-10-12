import type { Operation } from "effection";
import { toPortableSchema } from "@sweatpants/agent-sdk";
import {
  decisionRequestSchema,
  decisionResultSchema,
  type DecisionBinding,
  type DecisionRequest,
  type DecisionResult,
} from "@sweatpants/model-decision";

export const decisionBinding: DecisionBinding = Object.freeze({
  provider: "opencode",
  id: "jev-1.13",
});
export interface DecisionContext {
  decision(request: DecisionRequest): Operation<DecisionResult>;
}
export const decisionContract = {
  name: "decision",
  description:
    "Classify explicit input into one of the supplied choices using a decision model. Returns {answer,model,usage}. answer is either {type:'choice',choice,probabilities,confidence} or {type:'refusal'}. Confidence is distinct from the probability of the selected choice. No conversation history is inherited. You choose the categories and any uncertainty policy.",
  parameters: toPortableSchema(decisionRequestSchema, {
    identity: "tool:decision/parameters",
    role: "tool_parameters",
    version: "1",
  }).descriptor.inputProjection,
  output: toPortableSchema(decisionResultSchema, {
    identity: "tool:decision/output",
    role: "tool_output",
    version: "1",
  }).descriptor.outputProjection,
  elicits: {},
};
