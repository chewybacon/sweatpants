// Build-time checking against the workspace SDK source, before module evaluation.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const ts = createRequire(new URL("../../../package.json", import.meta.url))("typescript");
const filename = fileURLToPath(
    new URL("../../../packages/agent-sdk/__compiled_workflow__.ts", import.meta.url),
);
const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    customConditions: ["development"],
    strict: true,
    noImplicitReturns: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    esModuleInterop: true,
    types: [],
};
export function checkToolDefinition(source) {
    const host = ts.createCompilerHost(options);
    const read = host.readFile.bind(host),
        exists = host.fileExists.bind(host),
        get = host.getSourceFile.bind(host);
    host.readFile = (path) => (path === filename ? source : read(path));
    host.fileExists = (path) => path === filename || exists(path);
    host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
        path === filename
            ? ts.createSourceFile(path, source, languageVersion, true)
            : get(path, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram([filename], options, host);
    const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .filter((d) => d.category === ts.DiagnosticCategory.Error)
        .map((d) => {
            const position =
                d.file && d.start !== undefined
                    ? d.file.getLineAndCharacterOfPosition(d.start)
                    : undefined;
            return {
                code: d.code,
                message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
                ...(d.file
                    ? { file: d.file.fileName === filename ? "workflow.ts" : d.file.fileName }
                    : {}),
                ...(position ? { line: position.line + 1, column: position.character + 1 } : {}),
            };
        });
    if (diagnostics.length) {
        const error = new SyntaxError(
            diagnostics
                .map(
                    (d) =>
                        `${d.file ?? "TypeScript"}${d.line ? `:${d.line}:${d.column}` : ""} TS${d.code}: ${d.message}`,
                )
                .join("\n"),
        );
        error.code = "workflow_typecheck_failed";
        error.diagnostics = diagnostics;
        throw error;
    }
}
