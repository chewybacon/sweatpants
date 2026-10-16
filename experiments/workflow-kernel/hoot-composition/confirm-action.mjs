import { createRequire } from "node:module";
import { emitWorkflowScheme } from "../scheme-compiler/emit.mjs";
const { z } = createRequire(new URL("../../../packages/agent-sdk/package.json", import.meta.url))(
    "zod",
);

// A portable developer function, with no executable top-level entry.
export const developerSource = `
function* confirm_action(ctx, message) {
  "use workflow";
  const response = yield* ctx.elicit("approval", message);
  if (response.action !== "accept") {
    return false;
  }
  return response.content.approved;
}`;
export const emitted = emitWorkflowScheme(developerSource, {
    entryPoint: null,
    entryInput: true,
    allowFinally: true,
});

// Hand-authored stand-in for model output: no generated answer or fabricated user reply.
export const callerSource = `
(define (caller)
  (let ((label "Draft 17"))
    (if (confirm_action #f (string-append "Approve " label "?"))
      (string-append label ": approved")
      (string-append label ": declined"))))
(caller)
`;
export const source = emitted.scheme + callerSource;
export const approvalResponse = z.discriminatedUnion("action", [
    z
        .object({
            action: z.literal("accept"),
            content: z.object({ approved: z.boolean() }).strict(),
        })
        .strict(),
    z.object({ action: z.literal("decline") }).strict(),
]);
export const confirmationResult = z.boolean();

// Boundary validation belongs to the host contract. The emitter does not infer a
// runtime validator from TypeScript, and the evaluator never invents user input.
export function resumeApproval(machine, reply) {
    return machine.resume(approvalResponse.parse(reply));
}
