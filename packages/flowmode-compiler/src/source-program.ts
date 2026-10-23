import type { ValueType } from "./scheme-ir.js";
import ts from "typescript-api";
import type * as Babel from "@babel/core";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { Diagnostic, WorkflowSource } from "@sweatpants/flowmode-runtime";
const babel = createRequire(import.meta.url)("@babel/core") as typeof Babel;
const t = babel.types;

/** One source snapshot supplies both TypeScript symbols and executable module resolution. */
export function createSourceProgram(source: WorkflowSource) {
  const filename = resolve(source.id);
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    customConditions: [],
  };
  const host = ts.createCompilerHost(options),
    read = host.getSourceFile.bind(host),
    exists = host.fileExists.bind(host);
  host.fileExists = (path) => resolve(path) === filename || exists(path);
  host.getSourceFile = (path, version, onError, fresh) =>
    resolve(path) === filename
      ? ts.createSourceFile(filename, source.text, version, true)
      : read(path, version, onError, fresh);
  const program = ts.createProgram([filename], options, host),
    checker = program.getTypeChecker();
  const root = program.getSourceFile(filename)!;
  const diagnostics = (): Diagnostic[] =>
    ts.getPreEmitDiagnostics(program).map((d) => {
      const result: Diagnostic = {
        severity: d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
        code: `TS${d.code}`,
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        // CONDITIONAL-SPREAD: Global TypeScript diagnostics have no source position.
        ...(d.file && d.start !== undefined
          ? {
              position: {
                sourceId: d.file.fileName === filename ? source.id : d.file.fileName,
                line: d.file.getLineAndCharacterOfPosition(d.start).line + 1,
                column: d.file.getLineAndCharacterOfPosition(d.start).character + 1,
              },
            }
          : {}),
      };
      return result;
    });
  function fail(node: ts.Node, message: string): never {
    const sf = node.getSourceFile(),
      p = sf.getLineAndCharacterOfPosition(node.getStart());
    throw Object.assign(Error(message), {
      position: {
        sourceId: sf.fileName === filename ? source.id : sf.fileName,
        line: p.line + 1,
        column: p.character + 1,
      },
    });
  }
  const canonical = (symbol: ts.Symbol): ts.Symbol =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const modules: ts.SourceFile[] = [],
    active = new Set<string>(),
    visited = new Set<string>();
  function visit(sf: ts.SourceFile, rootModule: boolean): void {
    if (visited.has(sf.fileName)) {
      return;
    }
    active.add(sf.fileName);
    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.isTypeOnly) {
          continue;
        }
        if (!clause) {
          fail(statement, "Side-effect imports are unsupported in workflows");
        }
        const named = clause.namedBindings;
        if (clause.name || !named || !ts.isNamedImports(named)) {
          fail(statement, "Workflow helpers require named imports");
        }
        const runtime = named.elements.filter((e) => !e.isTypeOnly);
        if (!runtime.length) {
          continue;
        }
        const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
        if (!specifier.startsWith(".")) {
          if (
            (rootModule &&
              ["@sweatpants/agent-sdk", "@sweatpants/agent-sdk/tool", "zod"].includes(specifier)) ||
            specifier === "effection"
          ) {
            continue;
          }
          fail(statement, "Unsupported import: workflow helpers must be local TypeScript modules");
        }
        const moduleSymbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
        const dependency = moduleSymbol?.declarations?.find(ts.isSourceFile);
        if (!dependency || dependency.isDeclarationFile) {
          fail(statement, `Cannot resolve workflow helper source ${specifier}`);
        }
        if (active.has(dependency.fileName)) {
          fail(statement, "Workflow runtime import cycles are unsupported");
        }
        for (const imported of runtime) {
          const symbol = checker.getSymbolAtLocation(imported.name);
          const declaration = symbol && canonical(symbol).valueDeclaration;
          if (
            !declaration ||
            !ts.isFunctionDeclaration(declaration) ||
            declaration.getSourceFile() !== dependency
          ) {
            fail(imported, "Workflow helpers must import directly exported function declarations");
          }
        }
        visit(dependency, false);
      } else if (
        !rootModule &&
        !ts.isFunctionDeclaration(statement) &&
        !ts.isInterfaceDeclaration(statement) &&
        !ts.isTypeAliasDeclaration(statement)
      ) {
        fail(
          statement,
          "Workflow helper modules allow only function declarations and type declarations",
        );
      } else if (
        !rootModule &&
        ts.isFunctionDeclaration(statement) &&
        (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ||
          !statement.body)
      ) {
        fail(statement, "Workflow helpers require named function implementations");
      }
    }
    active.delete(sf.fileName);
    visited.add(sf.fileName);
    modules.push(sf);
  }
  visit(root, true);
  const symbols = new Map<ts.Symbol, string>();
  const reserved = new Set<string>();
  for (const sf of modules) {
    const scan = (n: ts.Node) => {
      if (ts.isIdentifier(n)) {
        reserved.add(n.text);
      }
      ts.forEachChild(n, scan);
    };
    scan(sf);
  }
  let serial = 0;
  for (const sf of modules) {
    for (const statement of sf.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const symbol = checker.getSymbolAtLocation(statement.name)!;
        let name = statement.name.text;
        if (sf !== root) {
          do {
            name = `__workflow_helper_${serial++}`;
          } while (reserved.has(name));
          reserved.add(name);
        }
        symbols.set(symbol, name);
      }
    }
  }
  // Intrinsic import aliases are module-local too; keep their export spelling intact.
  for (const sf of modules) {
    if (sf !== root) {
      for (const statement of sf.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !statement.importClause?.namedBindings ||
          !ts.isNamedImports(statement.importClause.namedBindings)
        ) {
          continue;
        }
        if ((statement.moduleSpecifier as ts.StringLiteral).text !== "effection") {
          continue;
        }
        for (const specifier of statement.importClause.namedBindings.elements) {
          if (specifier.isTypeOnly) {
            continue;
          }
          const symbol = checker.getSymbolAtLocation(specifier.name);
          if (symbol) {
            let name: string;
            do {
              name = `__workflow_api_${serial++}`;
            } while (reserved.has(name));
            reserved.add(name);
            symbols.set(symbol, name);
          }
        }
      }
    }
  }
  const types = new WeakMap<Babel.types.Node, ValueType>();
  const resolutions: { importer: string; specifier: string; resolved: string }[] = [];
  for (const sf of modules) {
    for (const statement of sf.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        statement.importClause?.isTypeOnly ||
        !(statement.moduleSpecifier as ts.StringLiteral).text.startsWith(".")
      ) {
        continue;
      }
      const target = checker
        .getSymbolAtLocation(statement.moduleSpecifier)
        ?.declarations?.find(ts.isSourceFile);
      if (target && !target.isDeclarationFile) {
        resolutions.push({
          importer: sf.fileName,
          specifier: (statement.moduleSpecifier as ts.StringLiteral).text,
          resolved: target.fileName,
        });
      }
    }
  }
  function valueType(type: ts.Type): ValueType {
    if (type.flags & ts.TypeFlags.StringLike) {
      return { kind: "string" };
    }
    if (type.flags & ts.TypeFlags.NumberLike) {
      return { kind: "number" };
    }
    if (type.flags & ts.TypeFlags.BooleanLike) {
      return { kind: "boolean" };
    }
    if (type.flags & ts.TypeFlags.Null) {
      return { kind: "null" };
    }
    // Structural types, unions, and generic instantiations retain source checking;
    // the current IR only needs their JSON boundary representation.
    return { kind: "json" };
  }
  const helperStatements: Babel.types.Statement[] = [];
  let rootAst: Babel.types.File | undefined;
  for (const sf of modules) {
    const ast = babel.parseSync(sf.text, {
      filename: sf === root ? source.id : sf.fileName,
      configFile: false,
      babelrc: false,
      parserOpts: { plugins: ["typescript"] },
    })!;
    t.traverseFast(ast, (node) => {
      if (node.loc) {
        node.loc.filename = sf === root ? source.id : sf.fileName;
      }
    });
    const names = new Map<number, string>();
    const parameterTypes = new Map<number, ValueType>();
    function scan(n: ts.Node) {
      if (ts.isParameter(n) && ts.isIdentifier(n.name)) {
        parameterTypes.set(n.name.getStart(sf), valueType(checker.getTypeAtLocation(n)));
      }
      if (ts.isIdentifier(n)) {
        const symbol = checker.getSymbolAtLocation(n);
        const replacement = symbol && (symbols.get(symbol) ?? symbols.get(canonical(symbol)));
        if (replacement) {
          names.set(n.getStart(sf), replacement);
        }
      }
      ts.forEachChild(n, scan);
    }
    scan(sf);
    const importedNames = ast.program.body
      .filter((n) => t.isImportDeclaration(n))
      .flatMap((n) =>
        n.specifiers
          .filter((s) => t.isImportSpecifier(s))
          .map((s) => ({ specifier: s, imported: t.cloneNode(s.imported) })),
      );
    t.traverseFast(ast, (node) => {
      if (t.isIdentifier(node)) {
        const type = parameterTypes.get(node.start!);
        if (type) {
          types.set(node, type);
        }
        const name = names.get(node.start!);
        if (name) {
          node.name = name;
        }
      }
    });
    for (const { specifier, imported } of importedNames) {
      specifier.imported = imported;
    }
    ast.program.body = ast.program.body.filter(
      (n) =>
        !(
          t.isImportDeclaration(n) &&
          (n.importKind === "type" ||
            n.source.value.startsWith(".") ||
            n.specifiers.every((s) => t.isImportSpecifier(s) && s.importKind === "type"))
        ),
    );
    if (sf === root) {
      rootAst = ast;
    } else {
      for (const statement of ast.program.body) {
        const declaration = t.isExportNamedDeclaration(statement)
          ? statement.declaration
          : statement;
        if (
          declaration &&
          (t.isFunctionDeclaration(declaration) || t.isImportDeclaration(declaration))
        ) {
          helperStatements.push(declaration);
        }
      }
    }
  }
  rootAst!.program.body.unshift(...helperStatements);
  return {
    ast: rootAst!,
    diagnostics,
    types,
    resolutions,
    dependencies: modules.filter((sf) => sf !== root).map((sf) => sf.fileName),
  };
}
