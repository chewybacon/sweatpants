/** Check only the current function: nested callbacks have their own lifecycle. */
export function validateCleanupPolicy(fn, types) {
    function walk(node, inFinally = false) {
        if (!node || typeof node !== "object") return;
        if (node !== fn && types.isFunction(node)) return;
        if (inFinally && types.isReturnStatement(node)) {
            const line = node.loc?.start.line;
            const column = node.loc ? node.loc.start.column + 1 : undefined;
            const error = new SyntaxError(
                `[workflow_cleanup_return] ${line ?? "?"}:${column ?? "?"}: ` +
                    "Returning from finally is not supported in compiled workflows. " +
                    "A return here can replace the pending return or error and interfere with cancellation unwinding. " +
                    "Move the return outside finally; keep this block for cleanup.",
            );
            Object.assign(error, { code: "workflow_cleanup_return", line, column });
            throw error;
        }
        for (const key of types.VISITOR_KEYS[node.type] ?? []) {
            const child = node[key];
            const cleanup = inFinally || (types.isTryStatement(node) && key === "finalizer");
            if (Array.isArray(child)) child.forEach((value) => walk(value, cleanup));
            else walk(child, cleanup);
        }
    }
    walk(fn);
}
