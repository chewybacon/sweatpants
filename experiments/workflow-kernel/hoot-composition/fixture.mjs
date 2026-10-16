import { emitWorkflowScheme } from "../scheme-compiler/emit.mjs";

// The real existing frontend emits the developer callee's Scheme and effect sites.
export const developerSource = `
import { ensure } from "effection";
function* workflow(ctx, input) {
  "use workflow";
  const hold = yield* ctx.elicit("reserve");
  yield* ensure(function* () {
    yield* ctx.elicit("release", hold.content);
  });
  const answer = yield* ctx.elicit("approve", hold.content);
  return answer.content;
}`;
export const emitted = emitWorkflowScheme(developerSource, {
    allowFinally: true,
    entryInput: true,
    allowEnsure: true,
});
// Replace only the compiler-generated entry invocation with an authored caller.
const entry = "\n(workflow #f %input)\n";
if (!emitted.scheme.endsWith(entry)) {
    throw Error("Unexpected compiler entry");
}
export const source =
    emitted.scheme.slice(0, -entry.length) +
    `
(define (caller)
  (let ((prefix "Caller received: "))
    (string-append prefix (workflow #f #f))))
(caller)
`;
