import { decodeRational } from "./numbers.mjs";

// Reader for the trusted experimental Scheme datum subset; no execution.
export function parse(source) {
  const tokens = source.match(/;[^\n]*|"(?:\\.|[^"\\])*"|[()]|[^\s()]+/g) ?? [];
  const ts = tokens.filter((t) => !t.startsWith(";"));
  let i = 0;
  function read() {
    const t = ts[i++];
    if (t === undefined) {
      throw Error("Unexpected end of source");
    }
    if (t === "(") {
      const xs = [];
      while (ts[i] !== ")") {
        if (i >= ts.length) {
          throw Error("Missing )");
        }
        xs.push(read());
      }
      i++;
      return xs;
    }
    if (t === ")") {
      throw Error("Unexpected )");
    }
    if (t.startsWith('"')) {
      if (t.length < 2 || !t.endsWith('"')) {
        throw Error("Unterminated string");
      }
      return t.slice(1, -1).replace(/\\(x[0-9a-fA-F]+;|u[0-9a-fA-F]{4}|[\s\S])/g, (_, escaped) => {
        if (escaped.startsWith("x") && escaped.length > 1) {
          return String.fromCodePoint(parseInt(escaped.slice(1, -1), 16));
        }
        if (escaped.startsWith("u") && escaped.length === 5) {
          return String.fromCharCode(parseInt(escaped.slice(1), 16));
        }
        const escapes = {
          a: "\x07",
          b: "\b",
          t: "\t",
          n: "\n",
          r: "\r",
          v: "\v",
          f: "\f",
          '"': '"',
          "\\": "\\",
          "/": "/",
        };
        if (!Object.hasOwn(escapes, escaped)) {
          throw Error("Unsupported string escape");
        }
        return escapes[escaped];
      });
    }
    if (t === "#t" || t === "#f") {
      return t === "#t";
    }
    if (/^[+-]?\d+\/[+-]?\d+$/.test(t)) {
      return decodeRational(t);
    }
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) {
      return Number(t);
    }
    return { sym: t };
  }
  const forms = [];
  while (i < ts.length) {
    forms.push(read());
  }
  return forms;
}
