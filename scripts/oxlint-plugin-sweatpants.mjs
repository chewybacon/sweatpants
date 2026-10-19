/**
 * Sweatpants lint rules.
 *
 * These enforce invariants the type system cannot express, and that greps
 * previously enforced with path-and-filename allowlists — a mechanism that
 * broke on ordinary refactors.
 *
 *   layered-imports   the durable type layers form a DAG; a lower layer may
 *                     never import an upper one
 *   documented-weld   a double type assertion must say why it is sound
 *   documented-scope-crossing
 *                     pinning a port to a foreign scope must say why the work
 *                     is not a child of the scope that configured it
 *   no-nested-yield   effectful intermediate values must have names
 *   no-conditional-spread
 *                     conditional object composition must explain its contract
 *
 * These are syntax-only. Oxlint JS plugins do not yet have type information, so
 * anything requiring types belongs in the built-in typescript-eslint rules
 * instead.
 */

/**
 * Durable type layers, lowest first. A module may import its own layer and any
 * layer below it, never above.
 *
 * Kept as file-name suffixes rather than directories so the rule works before
 * the modules are physically grouped, and keeps working afterwards.
 */
const LAYERS = ["durable-contract-types", "durable-protocol-types", "durable-authority-types"];

/** Layers that sit beside, not above, the stack: they may import any of it. */
const LEAF_CONSUMERS = ["durable-authoring-types"];

function layerOf(filename) {
  for (const [index, layer] of LAYERS.entries()) {
    if (filename.endsWith(`${layer}.ts`)) {
      return index;
    }
  }
  return undefined;
}

function importedLayer(specifier) {
  for (const [index, layer] of LAYERS.entries()) {
    if (specifier.endsWith(`${layer}.ts`) || specifier.endsWith(layer)) {
      return index;
    }
  }
  return undefined;
}

const layeredImports = {
  meta: {
    type: "problem",
    docs: {
      description: "durable type layers may only depend downward",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (LEAF_CONSUMERS.some((layer) => filename.endsWith(`${layer}.ts`))) {
      return {};
    }
    const own = layerOf(filename);
    if (own === undefined) {
      return {};
    }

    function check(node, specifier) {
      const target = importedLayer(specifier);
      if (target === undefined || target <= own) {
        return;
      }
      context.report({
        node,
        message:
          `${LAYERS[own]} must not import ${LAYERS[target]}. ` +
          `The durable type layers form a DAG (contract <- protocol <- authority) so that a ` +
          `journal-authority backend can depend on the contract without pulling in the ` +
          `authority protocol. Move the shared declaration down into the lower layer instead.`,
      });
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          check(node, node.source.value);
        }
      },
      ExportAllDeclaration(node) {
        if (node.source) {
          check(node, node.source.value);
        }
      },
    };
  },
};

const documentedWeld = {
  meta: {
    type: "problem",
    docs: {
      description: "a double type assertion must document why it is sound",
    },
    schema: [],
  },
  create(context) {
    const source = context.sourceCode ?? context.getSourceCode();
    const text = source.getText();
    const comments = source.getAllComments?.() ?? [];

    return {
      TSAsExpression(node) {
        // Only the double form (`x as unknown as T`) defeats the checker
        // outright; a single assertion still has to be assignable.
        if (node.expression?.type !== "TSAsExpression") {
          return;
        }
        if (documentedBy(text, comments, node, (comment) => /SAFETY:/.test(comment.value))) {
          return;
        }

        context.report({
          node,
          message:
            "Double type assertion needs a `// SAFETY:` comment naming the check that makes " +
            "it sound. Values crossing a journal or wire boundary must be validated by a " +
            "decoder; an undocumented weld here persists corrupt state that replays forever.",
        });
      },
    };
  },
};

/**
 * True when a comment matching `matches` documents `node`.
 *
 * Rather than walking parents to find the enclosing statement — the outermost
 * one is what carries the comment, and the innermost is what a naive walk
 * finds — this walks backwards from the node through the contiguous run of
 * comment lines directly above it.
 *
 * Only the gap between the nearest comment and the node is checked for real
 * code: crossing a `;` or a brace there means the comment belongs to something
 * else. Punctuation *inside* comment text is ignored, because prose routinely
 * contains semicolons and an earlier version of this helper rejected its own
 * justifications for exactly that reason.
 */
function documentedBy(text, comments, node, matches) {
  const preceding = comments
    .filter((comment) => comment.end <= node.start)
    .sort((left, right) => left.end - right.end);
  if (preceding.length === 0) {
    return false;
  }

  const nearest = preceding.at(-1);
  if (/[;{}]/.test(text.slice(nearest.end, node.start))) {
    return false;
  }

  // Walk back through the comment block, stopping at the first gap that
  // contains anything but whitespace.
  for (let index = preceding.length - 1; index >= 0; index -= 1) {
    const comment = preceding[index];
    if (matches(comment)) {
      return true;
    }
    const previous = preceding[index - 1];
    if (!previous || text.slice(previous.end, comment.start).trim() !== "") {
      return false;
    }
  }
  return false;
}

/**
 * True for `bind(yield* useScope())`, which pins a port to the caller's own
 * scope.
 *
 * That is the identity case: dispatch is unchanged, and the call only
 * materializes the port as a plain interface handle. Nothing crosses a scope,
 * so it needs no justification.
 */
function isSelfBind(node) {
  const [argument] = node.arguments ?? [];
  return (
    argument?.type === "YieldExpression" &&
    argument.argument?.type === "CallExpression" &&
    argument.argument.callee?.name === "useScope"
  );
}

/**
 * `SomethingPort.bind(scope)` resolves against a scope other than the caller's.
 *
 * It is occasionally necessary — a Host-owned writer task is deliberately not a
 * child of the request that configured it — but it is far more often a sign
 * that the scope tree is missing a node the domain already has. Requiring a
 * justification keeps the count visible and small; see
 * `docs/adr/004-turn-scope-and-scope-crossing.md`.
 *
 * Matched on the `*Port` naming convention because oxlint plugins are
 * syntax-only and cannot resolve the callee's type.
 */
const documentedScopeCrossing = {
  meta: {
    type: "problem",
    docs: {
      description: "pinning a port to a foreign scope must document why",
    },
    schema: [],
  },
  create(context) {
    const source = context.sourceCode ?? context.getSourceCode();
    const text = source.getText();
    const comments = source.getAllComments?.() ?? [];

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee?.type !== "MemberExpression" ||
          callee.property?.name !== "bind" ||
          !(callee.object?.name ?? "").endsWith("Port")
        ) {
          return;
        }
        if (isSelfBind(node)) {
          return;
        }
        // The kind is part of the marker, so an unclassified justification
        // does not satisfy the rule. "distribution" is deliberately
        // absent: at a real process boundary the bind is the defect, not
        // something to annotate.
        if (
          documentedBy(text, comments, node, (comment) =>
            /SCOPE-CROSSING \((?:missing node|ownership)\):/.test(comment.value),
          )
        ) {
          return;
        }

        context.report({
          node,
          message:
            "Binding a port to a foreign scope needs a `// SCOPE-CROSSING:` comment naming " +
            "the work that is not a child of the configuring scope, and its kind: a missing " +
            "scope node (fix by modelling it) or deliberate ownership (bind once, at " +
            "construction). If the far side is another thread, isolate, or machine, the bind " +
            "itself is the defect: pass serializable identity and re-resolve there. " +
            "See docs/adr/004-turn-scope-and-scope-crossing.md.",
        });
      },
    };
  },
};

function containsNestedYield(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (value.type === "YieldExpression") {
    return true;
  }
  if (
    value.type === "FunctionDeclaration" ||
    value.type === "FunctionExpression" ||
    value.type === "ArrowFunctionExpression"
  ) {
    // A function body executes later in its own operation. Yields inside it
    // are not operands of the outer yield expression.
    return false;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "parent" || key === "loc" || key === "range") {
      continue;
    }
    if (Array.isArray(child)) {
      if (child.some(containsNestedYield)) {
        return true;
      }
    } else if (containsNestedYield(child)) {
      return true;
    }
  }
  return false;
}

const noNestedYield = {
  meta: {
    type: "problem",
    docs: {
      description: "effectful intermediate values must be assigned before use",
    },
    schema: [],
  },
  create(context) {
    return {
      YieldExpression(node) {
        if (!containsNestedYield(node.argument)) {
          return;
        }
        context.report({
          node,
          message:
            "Do not nest `yield*` expressions. Assign the inner operation result to a " +
            "named variable, then use that variable in the outer operation.",
        });
      },
    };
  },
};

const noConditionalSpread = {
  meta: {
    type: "suggestion",
    docs: {
      description: "conditional object spreads must explain why omission or precedence is required",
    },
    schema: [],
  },
  create(context) {
    const source = context.sourceCode ?? context.getSourceCode();
    const text = source.getText();
    const comments = source.getAllComments?.() ?? [];

    function check(node) {
      if (node.type === "SpreadElement" && node.parent?.type !== "ObjectExpression") {
        return;
      }
      let argument = node.argument;
      while (
        argument &&
        [
          "ParenthesizedExpression",
          "TSAsExpression",
          "TSTypeAssertion",
          "TSNonNullExpression",
          "TSSatisfiesExpression",
        ].includes(argument.type)
      ) {
        argument = argument.expression;
      }
      if (argument?.type !== "ConditionalExpression" && argument?.type !== "LogicalExpression") {
        return;
      }
      if (
        documentedBy(text, comments, node, (comment) =>
          /CONDITIONAL-SPREAD:\s*\S/.test(comment.value),
        )
      ) {
        return;
      }
      context.report({
        node,
        message:
          "Use direct optional fields in live objects. When omission or precedence is required, add an adjacent `// CONDITIONAL-SPREAD: <reason>` explaining that contract. Normalize JSON at its boundary; do not hide the conditional in a helper.",
      });
    }
    return { SpreadElement: check, JSXSpreadAttribute: check };
  },
};

export default {
  meta: { name: "sweatpants" },
  rules: {
    "layered-imports": layeredImports,
    "documented-weld": documentedWeld,
    "documented-scope-crossing": documentedScopeCrossing,
    "no-nested-yield": noNestedYield,
    "no-conditional-spread": noConditionalSpread,
  },
};
