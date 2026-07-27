/**
 * Sweatpants lint rules.
 *
 * These enforce two invariants the type system cannot express, and that greps
 * previously enforced with path-and-filename allowlists — a mechanism that
 * broke on ordinary refactors.
 *
 *   layered-imports   the durable type layers form a DAG; a lower layer may
 *                     never import an upper one
 *   documented-weld   a double type assertion must say why it is sound
 *   documented-scope-crossing
 *                     pinning a port to a foreign scope must say why the work
 *                     is not a child of the scope that configured it
 *
 * Both are syntax-only. Oxlint JS plugins do not yet have type information, so
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
        const safetyComments = (source.getAllComments?.() ?? []).filter((comment) =>
            /SAFETY:/.test(comment.value),
        );

        return {
            TSAsExpression(node) {
                // Only the double form (`x as unknown as T`) defeats the checker
                // outright; a single assertion still has to be assignable.
                if (node.expression?.type !== "TSAsExpression") {
                    return;
                }
                if (safetyComments.some((comment) => documents(text, comment, node))) {
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
 * True when `comment` immediately precedes the statement containing `node`.
 *
 * Rather than walking parents to find the enclosing statement — the outermost
 * one is what carries the comment, and the innermost is what a naive walk
 * finds — this checks that nothing but whitespace, an assignment, and
 * declaration keywords sit between the comment and the assertion. Crossing a
 * `;` or a brace means the comment belongs to something else.
 */
function documents(text, comment, node) {
    if (comment.end > node.start) {
        return false;
    }
    const between = text.slice(comment.end, node.start);
    return !/[;{}]/.test(between);
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
        const crossingComments = (source.getAllComments?.() ?? []).filter((comment) =>
            /SCOPE-CROSSING:/.test(comment.value),
        );

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
                if (crossingComments.some((comment) => documents(text, comment, node))) {
                    return;
                }

                context.report({
                    node,
                    message:
                        "Binding a port to a foreign scope needs a `// SCOPE-CROSSING:` comment naming " +
                        "the work that is not a child of the configuring scope. If you cannot name it, " +
                        "the scope tree is probably missing a node the domain already has.",
                });
            },
        };
    },
};

export default {
    meta: { name: "sweatpants" },
    rules: {
        "layered-imports": layeredImports,
        "documented-weld": documentedWeld,
        "documented-scope-crossing": documentedScopeCrossing,
    },
};
