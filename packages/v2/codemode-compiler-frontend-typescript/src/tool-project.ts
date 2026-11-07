import { verifyWorkflowModule, type WorkflowModule } from "@sweatpan.ts/codemode-compiler";
import type { ScriptcModule } from "./scriptc.ts";
import type { AdmittedTool } from "./tool-admission.ts";

type Statement = ScriptcModule["functions"][number]["body"][number];
type Expression = Extract<Statement, { kind: "varDecl" }>["init"];
function fail(kind: string): never {
  throw new Error(`Unsupported tool projection: ${kind}`);
}
function quoted(value: string): string {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    fail("ill-formed Unicode");
  }
  return (
    '"' +
    value.replace(/["\\\x00-\x1f\x7f]/g, (c) =>
      c === '"' || c === "\\" ? "\\" + c : `\\x${c.charCodeAt(0).toString(16)};`,
    ) +
    '"'
  );
}

/** Project only ScriptC forms admitted by the public tool profile. */
export function projectTool(module: ScriptcModule, admitted: AdmittedTool): WorkflowModule {
  const fn = module.functions.find((candidate) => candidate.name === "workflow");
  if (
    !fn?.generator ||
    fn.params.length !== 1 ||
    fn.params[0]!.type.kind !== "string" ||
    fn.returnType.kind !== "string" ||
    fn.generator.nextT.kind !== "union"
  ) {
    fail("entry signature");
  }
  const union = module.unions?.find(
    (item) => item.id === (fn.generator!.nextT as { unionId: string }).unionId,
  );
  if (
    !union ||
    union.arms.length !== 2 ||
    union.discriminant?.field !== "ok" ||
    JSON.stringify(union.discriminant.cases) !==
      JSON.stringify([
        { tag: 0, values: [true] },
        { tag: 1, values: [false] },
      ])
  ) {
    fail("Outcome discriminant");
  }
  for (const [index, arm] of union.arms.entries()) {
    const shape =
      arm.kind === "record"
        ? module.records?.find((record) => record.id === arm.shapeId)
        : undefined;
    if (
      !shape ||
      shape.fields.length !== 2 ||
      !shape.fields.some((field) => field.name === "ok" && field.type.kind === "bool") ||
      !shape.fields.some(
        (field) =>
          field.name === (index === 0 ? "value" : "error") &&
          field.type.kind === (index === 0 ? "string" : "dyn"),
      )
    ) {
      fail("Outcome shape");
    }
  }
  const bindings = new Map(fn.locals.map((local, index) => [local.id, `local_${index}`]));
  const binding = (id: string) => bindings.get(id) ?? fail("unknown local");
  const effects: Record<string, WorkflowModule["effects"][string]> = {};
  let ordinal = 0;
  function expression(value: Expression): string {
    if (!value) {
      fail("missing expression");
    }
    switch (value.kind) {
      case "strLit":
        return quoted(value.value);
      case "varRef":
        return binding(value.localId);
      case "strConcat":
        return `(js-add ${expression(value.left)} ${expression(value.right)})`;
      case "arrayLit":
        return `(list ${value.elems.map(expression).join(" ")})`;
      case "unionDisc":
        if (value.unionId !== union!.id || value.field !== "ok") {
          fail("union discriminant");
        }
        return `(json-field ${expression(value.value)} "ok")`;
      case "unionNarrow":
        if (value.unionId !== union!.id || ![0, 1].includes(value.tag)) {
          fail("union narrowing");
        }
        return expression(value.value);
      case "recordGet":
        if (
          value.field !== "value" ||
          !union!.arms.some((arm) => arm.kind === "record" && arm.shapeId === value.shapeId)
        ) {
          fail("record field");
        }
        return `(json-field ${expression(value.obj)} "value")`;
      case "yieldExpr": {
        const site = admitted.sites[value.loc.start];
        if (
          !site ||
          value.loc.file !== "workflow.ts" ||
          !value.value ||
          value.delegated ||
          value.awaited ||
          value.captureCompletion
        ) {
          fail("unadmitted yield");
        }
        const key = `${site.key}:${ordinal++}`;
        effects[key] = { key: site.key, effect: site.effect, source: site.source };
        return `(yield-at ${quoted(key)} ${expression(value.value)})`;
      }
      default:
        return fail(value.kind);
    }
  }
  function body(statements: Statement[]): string {
    return statements
      .map((statement): string => {
        switch (statement.kind) {
          case "varDecl":
            return `(define ${binding(statement.localId)} ${expression(statement.init)})`;
          case "exprStmt":
            return expression(statement.expr);
          case "return":
            if (!statement.value) {
              fail("void return");
            }
            return `(workflow-return ${expression(statement.value)})`;
          case "if":
            if (statement.cond.type.kind !== "bool") {
              fail("non-boolean condition");
            }
            return `(if ${expression(statement.cond)} (block ${body(statement.then)}) (block ${body(statement.else_ ?? [])}))`;
          case "tryCatch":
            if (statement.catchBody || !statement.finallyBody || statement.suppressFinallyErrors) {
              fail("unsupported exception policy");
            }
            return `(try-finally (block ${body(statement.tryBody)}) (block ${body(statement.finallyBody)}))`;
          case "runtimeFence":
            if (statement.code !== "SC9002") {
              fail("runtime fence");
            }
            return `(workflow-throw ${quoted(statement.message)})`;
          default:
            return fail(statement.kind);
        }
      })
      .join("\n");
  }
  const sexpressions = `(define (workflow ${binding(fn.params[0]!.localId)})\n${body(fn.body)})`;
  if (Object.keys(effects).length !== Object.keys(admitted.sites).length) {
    fail("missing admitted effects");
  }
  const result: WorkflowModule = {
    format: "workflow-scheme/1",
    entry: { name: "workflow", parameters: "input" },
    sexpressions,
    effects,
  };
  verifyWorkflowModule(result);
  return result;
}
