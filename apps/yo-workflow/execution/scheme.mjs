import { createWorkflowGuidance } from "../../../packages/flowmode-runtime/dist/index.js";
import { reviewDraft } from "../../../experiments/workflow-kernel/tsdown-authoring/dist/review-draft.workflow.artifact.mjs";
export function schemeStack(authoring) {
  return {
    ...authoring,
    authoring: createWorkflowGuidance(
      "scheme",
      `Write a Scheme caller for a durable workflow evaluator. Return only Scheme source, without Markdown.
Available compiled developer function: (review_draft input). input is a JSON object with title (string), recipient (string), metadata (JSON value). It asks the human for approval, registers cleanup that asks the human to release the reservation, and returns the string "Draft approved" or "Draft declined". Call it; do not redefine it or simulate its effects.
The caller must define (workflow input) and end with (workflow %input). %input is provided by the host. Available host tool: (send_announcement input). It queues an announcement in the local outbox and returns a JSON object with announcementId, status, title, recipient. Call it only after review_draft returns "Draft approved". Return its receipt or a string explaining the decline. The host owns execution; do not implement this tool.
Use define, let, let*, if, equal?, json-field, string-append and ordinary function calls. No imports, eval, external APIs, or direct effects. Preserve the tool result. This experiment has no email-sending capability.
The host supplies title, recipient, and metadata in input; pass input directly to both tools. Do not invent JSON literal syntax.`,
    ),
    descriptor: {
      id: "scheme",
      label: "Scheme",
      runtime: "Hoot / Wasm",
      developerLanguage: "TypeScript",
    },
    caller: "(define (workflow input) (review_draft input))\n(workflow %input)",
    *definition() {
      return reviewDraft;
    },
  };
}
