import type { WorkflowModule } from "./contracts.ts";

type Datum = string | boolean | { symbol: string } | Datum[];
const identifier = /^[A-Za-z_][A-Za-z0-9_?!-]*$/;
const primitives = new Map([
  ["js-add", 2],
  ["json-field", 2],
  ["not", 1],
  ["truthy", 1],
]);
const reserved = new Set([
  ...primitives.keys(),
  "list",
  "define",
  "lambda",
  "if",
  "block",
  "yield-at",
  "workflow-return",
  "workflow-throw",
  "try-finally",
  "set!",
  "begin",
  "let",
  "let*",
  "while",
  "break",
  "continue",
  "scope",
  "ensure",
  "quote",
  "registered-program",
  "object",
  "equal?",
  "string-append",
  "root",
]);
function fail(detail: string): never {
  throw new Error(`Invalid workflow module: ${detail}`);
}
const symbol = (datum: Datum | undefined): string | undefined =>
  datum && typeof datum === "object" && !Array.isArray(datum) ? datum.symbol : undefined;

// Compiler-profile reader, not the runtime's general JSON/Scheme wire codec.
// Consume every character; reject reader extensions, numeric coercion and oversized IR.
function read(source: string): Datum[] {
  if (source.length > 1_000_000) {
    fail("source budget exceeded");
  }
  let offset = 0,
    count = 0;
  function space() {
    while (offset < source.length) {
      if (/\s/.test(source[offset]!)) {
        offset++;
      } else if (source[offset] === ";") {
        while (offset < source.length && source[offset] !== "\n") {
          offset++;
        }
      } else {
        break;
      }
    }
  }
  function datum(depth: number): Datum {
    if (++count > 50_000 || depth > 128) {
      fail("structure budget exceeded");
    }
    space();
    const char = source[offset++];
    if (char === "(") {
      const list: Datum[] = [];
      space();
      while (source[offset] !== ")") {
        if (offset >= source.length) {
          fail("missing closing parenthesis");
        }
        list.push(datum(depth + 1));
        space();
      }
      offset++;
      return list;
    }
    if (char === '"') {
      let value = "",
        closed = false;
      while (offset < source.length) {
        const next = source[offset++]!;
        if (next === '"') {
          closed = true;
          break;
        }
        if (next !== "\\") {
          value += next;
          continue;
        }
        const escaped = source[offset++];
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          n: "\n",
          r: "\r",
          t: "\t",
          b: "\b",
          f: "\f",
          a: "\x07",
          v: "\v",
        };
        if (escaped && Object.hasOwn(simple, escaped)) {
          value += simple[escaped];
        } else if (escaped === "x") {
          const hex = /^[0-9a-fA-F]+;/.exec(source.slice(offset))?.[0];
          if (!hex || hex.length > 7) {
            fail("invalid string escape");
          }
          const point = parseInt(hex.slice(0, -1), 16);
          if (point > 0x10ffff) {
            fail("invalid string escape");
          }
          value += String.fromCodePoint(point);
          offset += hex.length;
        } else if (escaped === "u") {
          const hex = /^[0-9a-fA-F]{4}/.exec(source.slice(offset))?.[0];
          if (!hex) {
            fail("invalid string escape");
          }
          value += String.fromCharCode(parseInt(hex, 16));
          offset += 4;
        } else {
          fail("unsupported string escape");
        }
      }
      if (!closed) {
        fail("unterminated string");
      }
      if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
        fail("strings require well-formed Unicode");
      }
      return value;
    }
    if (!char || char === ")") {
      fail("unexpected end or closing parenthesis");
    }
    const start = offset - 1;
    while (offset < source.length && !/[\s();]/.test(source[offset]!)) {
      offset++;
    }
    const token = source.slice(start, offset);
    if (token === "#t" || token === "#f") {
      return token === "#t";
    }
    if (!identifier.test(token)) {
      fail(`unsupported token ${token}`);
    }
    return { symbol: token };
  }
  const forms: Datum[] = [];
  space();
  while (offset < source.length) {
    forms.push(datum(0));
    space();
  }
  return forms;
}

/** Verify the serialized, bounded workflow-scheme/1 profile without executing it.
 * Checks lexical structure, entry arity and literal effect-site/identity correlation.
 * Does not validate schemas, grant effects, prove termination or authorize artifacts.
 * Targets may reject additional forms they do not implement. No verification token
 * is cached: consumers must verify the exact module they are about to use.
 */
export function verifyWorkflowModule(module: WorkflowModule): void {
  if (
    !module ||
    module.format !== "workflow-scheme/1" ||
    typeof module.sexpressions !== "string" ||
    module.entry?.parameters !== "input" ||
    !identifier.test(module.entry.name) ||
    !module.effects ||
    typeof module.effects !== "object" ||
    Array.isArray(module.effects)
  ) {
    fail("unsupported profile");
  }
  for (const [site, effect] of Object.entries(module.effects)) {
    if (
      !site ||
      !effect ||
      typeof effect.key !== "string" ||
      !effect.key ||
      typeof effect.effect !== "string" ||
      !effect.effect ||
      typeof effect.source?.id !== "string" ||
      !effect.source.id ||
      !Number.isSafeInteger(effect.source.line) ||
      effect.source.line < 1 ||
      (effect.source.column !== undefined &&
        (!Number.isSafeInteger(effect.source.column) || effect.source.column < 1))
    ) {
      fail("invalid effect metadata");
    }
  }
  const forms = read(module.sexpressions);
  const functions = new Map<string, number>();
  const name = (value: Datum | undefined): string => {
    const id = symbol(value);
    if (!id || reserved.has(id)) {
      return fail("invalid binding");
    }
    return id;
  };
  const list = (value: Datum | undefined): Datum[] =>
    Array.isArray(value) ? value : fail("expected list");
  const parameters = (value: Datum | undefined): string[] => {
    const names = list(value).map(name);
    if (new Set(names).size !== names.length) {
      fail("duplicate parameters");
    }
    return names;
  };
  for (const form of forms) {
    const parts = list(form);
    if (symbol(parts[0]) !== "define" || parts.length < 3) {
      fail("expected function definition");
    }
    const signature = list(parts[1]);
    const id = name(signature[0]);
    if (functions.has(id)) {
      fail("duplicate function");
    }
    functions.set(id, parameters(signature.slice(1)).length);
  }
  if (functions.get(module.entry.name) !== 1) {
    fail("entry must name a one-input function");
  }
  const seenSites = new Set<string>();
  function expression(value: Datum | undefined, env: Set<string>): void {
    if (typeof value === "string" || typeof value === "boolean") {
      return;
    }
    const id = symbol(value);
    if (id) {
      if (!env.has(id)) {
        fail(`unbound identifier ${id}`);
      }
      return;
    }
    const parts = list(value),
      head = symbol(parts[0]);
    if (!parts.length) {
      fail("empty expression");
    }
    if (head === "lambda") {
      const params = parameters(parts[1]);
      body(parts.slice(2), new Set([...env, ...params]));
      return;
    }
    if (head === "yield-at") {
      const site = parts[1];
      if (parts.length !== 3 || typeof site !== "string" || !Object.hasOwn(module.effects, site)) {
        fail("undeclared effect site");
      }
      if (seenSites.has(site)) {
        fail("duplicate effect site");
      }
      seenSites.add(site);
      const request = list(parts[2]);
      if (
        request.length !== 4 ||
        symbol(request[0]) !== "list" ||
        request[1] !== "effect" ||
        request[2] !== module.effects[site]!.effect
      ) {
        fail("effect identity mismatch");
      }
      expression(request[3], env);
      return;
    }
    if (head === "list") {
      parts.slice(1).forEach((item) => expression(item, env));
      return;
    }
    if (head && primitives.has(head)) {
      if (
        parts.length !== primitives.get(head)! + 1 ||
        (head === "json-field" && typeof parts[2] !== "string")
      ) {
        fail("invalid primitive arguments");
      }
      parts.slice(1).forEach((item) => expression(item, env));
      return;
    }
    expression(parts[0], env);
    parts.slice(1).forEach((item) => expression(item, env));
  }
  function body(forms: Datum[], env: Set<string>): void {
    if (!forms.length) {
      fail("empty function body");
    }
    for (const form of forms) {
      const parts = Array.isArray(form) ? form : undefined;
      const head = parts && symbol(parts[0]);
      if (head === "define") {
        if (parts!.length !== 3) {
          fail("invalid definition");
        }
        const id = name(parts![1]);
        if (env.has(id)) {
          fail("duplicate local binding");
        }
        expression(parts![2], env);
        env.add(id);
      } else if (head === "set!") {
        if (parts!.length !== 3 || !env.has(name(parts![1])) || functions.has(name(parts![1]))) {
          fail("invalid assignment");
        }
        expression(parts![2], env);
      } else if (head === "workflow-return" || head === "workflow-throw") {
        if (parts!.length !== 2) {
          fail("invalid completion");
        }
        expression(parts![1], env);
      } else if (head === "try-finally" || head === "if") {
        if (parts!.length !== (head === "if" ? 4 : 3)) {
          fail("invalid control form");
        }
        if (head === "if") {
          expression(parts![1], env);
        }
        for (const branch of parts!.slice(head === "if" ? 2 : 1)) {
          const region = list(branch);
          if (symbol(region[0]) !== "block") {
            fail("expected block");
          }
          if (region.length > 1) {
            body(region.slice(1), new Set(env));
          }
        }
      } else {
        expression(form, env);
      }
    }
  }
  for (const form of forms) {
    const parts = list(form),
      signature = list(parts[1]);
    const params = parameters(signature.slice(1));
    body(parts.slice(2), new Set([...functions.keys(), ...params]));
  }
}
