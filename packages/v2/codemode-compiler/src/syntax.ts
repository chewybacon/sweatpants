/** Bounded parsed view for compiler targets. Serialized interchange remains S-expression text.
 * The caller mode additionally admits safe integer literals and the input binding.
 * Reading is not structural verification or execution authorization. */
export type WorkflowDatum = string | boolean | number | { sym: string } | WorkflowDatum[];
const identifier = /^[A-Za-z_][A-Za-z0-9_?!-]*$/;
function fail(detail: string): never {
  throw new Error(`Invalid workflow module: ${detail}`);
}
export const workflowSymbolName = (datum: WorkflowDatum | undefined): string | undefined =>
  datum && typeof datum === "object" && !Array.isArray(datum) ? datum.sym : undefined;

// Compiler-profile reader, not the runtime's general JSON/Scheme wire codec.
// Consume every character; reject reader extensions, numeric coercion and oversized IR.
export function readWorkflowSExpressions(source: string, caller = false): WorkflowDatum[] {
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
  function datum(depth: number): WorkflowDatum {
    if (++count > 50_000 || depth > 128) {
      fail("structure budget exceeded");
    }
    space();
    const char = source[offset++];
    if (char === "(") {
      const list: WorkflowDatum[] = [];
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
    if (
      caller &&
      /^[+-]?\d+$/.test(token) &&
      Number.isSafeInteger(Number(token)) &&
      !Object.is(Number(token), -0)
    ) {
      return Number(token);
    }
    if (!identifier.test(token) && !(caller && token === "%input")) {
      fail(`unsupported token ${token}`);
    }
    return { sym: token };
  }
  const forms: WorkflowDatum[] = [];
  space();
  while (offset < source.length) {
    forms.push(datum(0));
    space();
  }
  return forms;
}
