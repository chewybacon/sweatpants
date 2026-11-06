import { assertDeclarationProfile, expandEffectMacro } from "./macros.mts";
import { createRequire } from "node:module";
const {
  parseSync,
  traverse,
  types: t,
} = createRequire(new URL("../../../packages/flowmode-compiler/package.json", import.meta.url))(
  "@babel/core",
);
const parse = (text) =>
  parseSync(text, {
    configFile: false,
    babelrc: false,
    sourceType: "module",
    parserOpts: { plugins: ["typescript"] },
  });
const fail = (message) => {
  throw new Error(`Workflow admission: ${message}`);
};

// Bounded authoring adapter, not a JS sandbox. Its output is still subject to
// strict IR projection. No authored JS is evaluated to discover capabilities.
export function admitWorkflow(text, helperText, elicits) {
  const ast = parse(text);
  const helper = parse(helperText);
  const helperExport = helper.program.body;
  if (helperExport.length !== 1 || !t.isExportNamedDeclaration(helperExport[0])) {
    fail("helper must contain only an exported function");
  }
  const helperFn = helperExport[0].declaration;
  if (
    !t.isFunctionDeclaration(helperFn) ||
    helperFn.id.name !== "message" ||
    helperFn.async ||
    helperFn.generator ||
    helperFn.params.length !== 2 ||
    !helperFn.params.every(
      (p) =>
        t.isIdentifier(p) && t.isTSStringKeyword(p.typeAnnotation?.typeAnnotation) && !p.optional,
    ) ||
    !t.isTSStringKeyword(helperFn.returnType?.typeAnnotation) ||
    helperFn.body.body.length !== 1
  ) {
    fail("unsupported helper declaration");
  }
  const result = helperFn.body.body[0];
  if (
    !t.isReturnStatement(result) ||
    !t.isBinaryExpression(result.argument, { operator: "+" }) ||
    !t.isIdentifier(result.argument.left, { name: helperFn.params[0].name }) ||
    !t.isIdentifier(result.argument.right, { name: helperFn.params[1].name })
  ) {
    fail("helper must return the concatenation of its two parameters");
  }
  let declaration;
  for (const node of ast.program.body) {
    if (t.isImportDeclaration(node)) {
      if (
        node.importKind === "type" &&
        ["effection", "../contract.mjs"].includes(node.source.value)
      ) {
        continue;
      }
      if (
        node.source.value !== "./helper.js" ||
        node.specifiers.length !== 1 ||
        !t.isImportSpecifier(node.specifiers[0]) ||
        node.specifiers[0].imported.name !== "message"
      ) {
        fail("unapproved runtime import");
      }
    } else if (t.isExportNamedDeclaration(node) && t.isFunctionDeclaration(node.declaration)) {
      if (declaration) {
        fail("one workflow export required");
      }
      declaration = node.declaration;
    } else {
      fail("top-level execution is not admitted");
    }
  }
  if (
    !declaration ||
    declaration.id.name !== "review" ||
    !declaration.generator ||
    declaration.async ||
    declaration.params.length !== 2 ||
    !declaration.params.every((p) => t.isIdentifier(p)) ||
    !declaration.body.directives.some((d) => d.value.value === "use workflow")
  ) {
    fail("expected review(input, ctx) with use workflow");
  }
  const edits = [];
  const sites = [];
  const input = declaration.params[0];
  const context = declaration.params[1];
  const reference = (node, name) =>
    t.isTSTypeReference(node) && t.isIdentifier(node.typeName, { name });
  const returned = declaration.returnType?.typeAnnotation;
  if (
    !t.isTSStringKeyword(input.typeAnnotation?.typeAnnotation) ||
    input.optional ||
    context.optional ||
    !reference(context.typeAnnotation?.typeAnnotation, "WorkflowContext") ||
    context.typeAnnotation.typeAnnotation.typeParameters ||
    !reference(returned, "Operation") ||
    returned.typeParameters?.params.length !== 1 ||
    !t.isTSStringKeyword(returned.typeParameters.params[0]) ||
    declaration.typeParameters
  ) {
    fail("supported entry signature is (input: string, ctx: WorkflowContext): Operation<string>");
  }
  for (const [name, source] of [
    ["Operation", "effection"],
    ["WorkflowContext", "../contract.mjs"],
  ]) {
    if (
      !ast.program.body.some(
        (node) =>
          t.isImportDeclaration(node) &&
          node.importKind === "type" &&
          node.source.value === source &&
          node.specifiers.some(
            (s) => t.isImportSpecifier(s) && s.local.name === name && s.imported.name === name,
          ),
      )
    ) {
      fail(`expected trusted type import ${name}`);
    }
  }
  // Normalization may erase only the exact signature validated above. Ordinary
  // body/helper types remain in ScriptC's input and are checked there.
  // Keep ordinary TypeScript authoring at the input; the frontend sees an
  // explicitly typed, single-exchange generator rather than an Effection object.
  edits.push({
    start: declaration.start,
    end: declaration.body.start,
    value: `function* review(${input.name}: string): Generator<string[], string, string> `,
  });
  for (const node of ast.program.body) {
    if (t.isImportDeclaration(node) && node.importKind === "type") {
      edits.push({ start: node.start, end: node.end, value: "" });
    }
  }
  const admittedNodes = new Set([
    "File",
    "Program",
    "ImportDeclaration",
    "ImportSpecifier",
    "ExportNamedDeclaration",
    "FunctionDeclaration",
    "BlockStatement",
    "Directive",
    "DirectiveLiteral",
    "Identifier",
    "StringLiteral",
    "NumericLiteral",
    "VariableDeclaration",
    "VariableDeclarator",
    "ArrowFunctionExpression",
    "CallExpression",
    "MemberExpression",
    "YieldExpression",
    "ObjectExpression",
    "ObjectProperty",
    "TryStatement",
    "ReturnStatement",
    "ExpressionStatement",
    "AssignmentExpression",
    "BinaryExpression",
    "TSTypeAnnotation",
    "TSTypeReference",
    "TSTypeParameterInstantiation",
    "TSStringKeyword",
  ]);
  traverse(ast, {
    enter(path) {
      if (!admittedNodes.has(path.node.type)) {
        fail(`unsupported syntax ${path.node.type}`);
      }
      if (
        path.isReferencedIdentifier() &&
        !path.findParent((p) => p.isTSType()) &&
        !path.scope.getBinding(path.node.name)
      ) {
        fail(`unbound identifier ${path.node.name}`);
      }
      if (path.isArrowFunctionExpression() && (path.node.async || path.node.generator)) {
        fail("only synchronous closures are admitted");
      }
      if (
        path.isAssignmentExpression() &&
        (path.node.operator !== "=" || !t.isIdentifier(path.node.left))
      ) {
        fail("only local assignment is admitted");
      }
      if (path.isBinaryExpression() && path.node.operator !== "+") {
        fail("only string concatenation is admitted");
      }
    },
    FunctionDeclaration(path) {
      if (path.node !== declaration) {
        fail("nested function declarations are not admitted");
      }
      const ctx = path.scope.getBinding(context.name);
      if (!ctx || ctx.constantViolations.length) {
        fail("context cannot be reassigned");
      }
      for (const ref of ctx.referencePaths) {
        const member = ref.parentPath;
        const call = member.parentPath;
        const suspension = call.parentPath;
        if (
          !member.isMemberExpression() ||
          member.node.computed ||
          member.node.object !== ref.node ||
          !t.isIdentifier(member.node.property) ||
          !call.isCallExpression() ||
          call.node.callee !== member.node ||
          !suspension.isYieldExpression() ||
          !suspension.node.delegate ||
          suspension.node.argument !== call.node ||
          suspension.getFunctionParent().node !== declaration
        ) {
          fail("context only supports directly yielded registered macro calls");
        }
        const [key, request] = call.node.arguments;
        if (
          call.node.arguments.length !== 2 ||
          !t.isStringLiteral(key) ||
          !Object.hasOwn(elicits, key.value)
        ) {
          fail("undeclared effect key");
        }
        if (!t.isObjectExpression(request) || request.properties.length !== 1) {
          fail("request must contain message only");
        }
        const property = request.properties[0];
        if (
          !t.isObjectProperty(property) ||
          property.computed ||
          !t.isIdentifier(property.key, { name: "message" })
        ) {
          fail("request must contain message only");
        }
        assertDeclarationProfile(key.value, elicits[key.value]);
        const expanded = expandEffectMacro(
          member.node.property.name,
          key.value,
          text.slice(property.value.start, property.value.end),
          elicits,
        );
        const value = expanded.source;
        edits.push({ start: suspension.node.start, end: suspension.node.end, value });
        sites.push({
          start: suspension.node.start,
          key: key.value,
          effect: expanded.effect,
          line: suspension.node.loc.start.line,
          column: suspension.node.loc.start.column + 1,
        });
      }
    },
    YieldExpression(path) {
      if (!sites.some((site) => site.start === path.node.start)) {
        fail("only declared macro yields are admitted");
      }
    },
    CallExpression(path) {
      const callee = path.get("callee");
      if (callee.isMemberExpression()) {
        if (!sites.some((site) => site.start === path.parentPath.node.start)) {
          fail("host/member calls are not admitted");
        }
        return;
      }
      if (!callee.isIdentifier()) {
        fail("unsupported call target");
      }
      const binding = path.scope.getBinding(callee.node.name);
      if (!binding || binding.constantViolations.length) {
        fail("unbound or reassigned call target");
      }
      if (
        binding.path.isImportSpecifier() &&
        binding.path.node.imported.name === "message" &&
        binding.path.parent.source.value === "./helper.js"
      ) {
        return;
      }
      if (
        binding.path.isVariableDeclarator() &&
        t.isArrowFunctionExpression(binding.path.node.init) &&
        !binding.path.node.init.async
      ) {
        return;
      }
      fail("unapproved call target");
    },
    NewExpression() {
      fail("host construction is not admitted");
    },
    MemberExpression(path) {
      if (!path.parentPath.isCallExpression() || path.parentPath.node.callee !== path.node) {
        fail("member access is not admitted");
      }
    },
  });
  // Reject overlapping edits (including nested capabilities) instead of silently
  // dropping source. Source offsets remain attached to each admitted exchange.
  edits.sort((a, b) => a.start - b.start);
  let cursor = 0,
    output = "";
  const mappedSites = {};
  for (const edit of edits) {
    if (edit.start < cursor) {
      fail("overlapping normalization");
    }
    output += text.slice(cursor, edit.start);
    const site = sites.find((s) => s.start === edit.start);
    if (site) {
      mappedSites[output.length] = { ...site, sourceId: "review.workflow.ts" };
    }
    output += edit.value;
    cursor = edit.end;
  }
  output += text.slice(cursor);
  return { source: output, sites: mappedSites };
}
