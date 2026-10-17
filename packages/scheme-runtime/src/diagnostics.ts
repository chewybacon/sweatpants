export interface SchemeDiagnostic {
  code: string;
  phase: "validation" | "input" | "execution";
  message: string;
  detail: string;
  identifier?: string;
  location?: { line: number; column: number };
}

/** Normalize Hoot's printed exception without treating compiler locations as user source. */
export function schemeDiagnostic(
  detail: string,
  phase: SchemeDiagnostic["phase"],
): SchemeDiagnostic {
  const printedMessage = /#<&message message: "((?:\\.|[^"\\])*)">/.exec(detail)?.[1];
  let message = printedMessage?.replace(/\\(["\\])/g, "$1") ?? detail;
  const identifier =
    message === "Unbound identifier"
      ? /#<&irritants irritants: \(([^\s()]+)\)>/.exec(detail)?.[1]
      : undefined;
  if (identifier) message = `Unbound identifier: ${identifier}`;
  // Only the reader's input position refers to authored source. hoot/errors.scm does not.
  const reader = /#<&i\/o-line-and-column line: (\d+) column: (\d+)>/.exec(detail);
  const location = reader ? { line: Number(reader[1]), column: Number(reader[2]) } : undefined;
  const code =
    message === "Scheme validation fuel exhausted"
      ? "E_VALIDATION_FUEL"
      : message.startsWith("E_")
        ? message.split(":", 1)[0]!
        : message.includes("Unbound identifier")
          ? "E_UNBOUND_IDENTIFIER"
          : reader
            ? "E_READ"
            : phase === "input"
              ? "E_INPUT"
              : "E_SCHEME";
  return {
    code,
    phase,
    message,
    detail,
    ...(identifier ? { identifier } : {}),
    ...(location ? { location } : {}),
  };
}
