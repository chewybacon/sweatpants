/** Adapt constructor calls to marker IR; the upstream parser still owns syntax. */
export function expandConstructors(
  source: string,
  constructors: Readonly<Record<string, string>>,
): string {
  let output = "";
  let quote = "";
  let escaped = false;
  const parentheses: boolean[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      output += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      output += ch;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const token = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))![0];
      const opening = /^\s*\(/.exec(source.slice(i + token.length));
      if (opening && Object.hasOwn(constructors, token)) {
        output += `Eval("${constructors[token]}", [`;
        parentheses.push(true);
        i += token.length + opening[0].length - 1;
      } else {
        output += token;
        i += token.length - 1;
      }
      continue;
    }
    if (ch === "(") {
      parentheses.push(false);
    }
    if (ch === ")" && parentheses.pop()) {
      output += "]";
    }
    output += ch;
  }
  return output;
}
