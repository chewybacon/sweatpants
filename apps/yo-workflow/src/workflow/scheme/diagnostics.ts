/** Advisory delimiter locations after Hoot rejects source; never a language validator. */
export function schemeSourceHint(source: string): string | undefined {
  const openings: number[] = [];
  const closed: number[] = [];
  const unexpected: number[] = [];
  let stringStart: number | undefined;
  let comment = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (comment) {
      if (character === "\n") {
        comment = false;
      }
      continue;
    }
    if (stringStart !== undefined) {
      if (character === "\\") {
        index++;
      } else if (character === '"') {
        stringStart = undefined;
      }
      continue;
    }
    if (character === ";") {
      comment = true;
    } else if (character === '"') {
      stringStart = index;
    }
    // Reader extensions (datum comments, characters, vectors, escaped symbols,
    // etc.) belong to Hoot. Omit hints rather than misread their delimiters.
    else if (
      character === "|" ||
      (character === "#" && !/^#[tf](?=[\s()]|$)/.test(source.slice(index)))
    ) {
      return undefined;
    } else if (character === "(") {
      openings.push(index);
    } else if (character === ")") {
      if (openings.length === 0) {
        unexpected.push(index);
      } else {
        openings.pop();
        if (openings.length === 0) {
          closed.push(index);
        }
      }
    }
  }
  const location = (index: number): string => {
    const before = source.slice(0, index);
    const line = before.split("\n").length;
    const column = index - before.lastIndexOf("\n");
    const excerpt = source
      .slice(index, source.indexOf("\n", index) < 0 ? source.length : source.indexOf("\n", index))
      .slice(0, 100);
    return `line ${line}, column ${column}: ${excerpt}`;
  };
  if (stringStart !== undefined) {
    return `Unclosed string starting at ${location(stringStart)}.`;
  }
  if (unexpected.length > 0) {
    return `Unexpected closing parentheses at ${unexpected.slice(0, 8).map(location).join("; ")}. Check the preceding helper's boundary.`;
  }
  if (openings.length > 0) {
    return `${openings.length} unmatched opening parentheses, starting at ${openings.slice(-8).map(location).join("; ")}. Check each helper's boundary; appending parentheses at EOF can leave later definitions inside an earlier helper.`;
  }
  if (closed.length > 1) {
    return `The outermost lists close at ${closed.slice(0, 8).map(location).join("; ")}. If this was intended as one let body, check whether a helper closed the outer scope early.`;
  }
  return undefined;
}
