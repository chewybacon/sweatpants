import { admitWorkflow } from "./admit.mjs";
import { describeAuthoring } from "./macros.mts";
import { project } from "./project.mjs";

export function admitInput(input) {
  if (
    input.source.language !== "typescript" ||
    input.source.id !== "review.workflow.ts" ||
    Object.keys(input.modules).length !== 1 ||
    !Object.hasOwn(input.modules, "helper.ts")
  ) {
    throw new Error("Unsupported experimental TypeScript source graph");
  }
  describeAuthoring(input.effects);
  const helperText = input.modules["helper.ts"];
  return { helperText, admitted: admitWorkflow(input.source.text, helperText, input.effects) };
}

export function projectWorkflow(ir, admitted, helperText) {
  const helperFunction = ir.functions.find(
    (f) => f.sourceName === "message" && f.loc.file === "helper.ts",
  );
  if (!helperFunction) {
    throw new Error("Missing imported helper IR");
  }
  const emitted = project(ir, admitted.source, {
    sites: admitted.sites,
    helpers: [helperFunction.name],
    sources: { "helper.ts": helperText },
  });
  return {
    debug: emitted.debug,
    module: {
      format: "workflow-scheme/1",
      sexpressions: emitted.payload,
      entry: { name: "review", parameters: "input" },
      effects: Object.fromEntries(
        Object.entries(emitted.debug.sites).map(([id, site]) => [
          id,
          {
            key: site.key,
            effect: site.effect,
            source: { id: site.sourceId, line: site.line, column: site.column },
          },
        ]),
      ),
    },
  };
}
