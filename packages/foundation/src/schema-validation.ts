import type { StandardSchemaV1 } from "@standard-schema/spec";
import { call, type Operation } from "effection";

/** Runs a Standard Schema validator without allowing its Promise to escape. */
export function* validateStandardSchema<Input = unknown, Output = unknown>(
  schema: StandardSchemaV1<Input, Output>,
  value: Input,
): Operation<StandardSchemaV1.Result<Output>> {
  const result = schema["~standard"].validate(value);
  if (isPromiseLike(result)) {
    return yield* call(() => Promise.resolve(result)) as Operation<StandardSchemaV1.Result<Output>>;
  }
  return result;
}

/** Bounded, redacted validation issue safe for durable boundaries. */
export interface SafeSchemaIssue {
  readonly message: string;
  readonly path?: string;
}

const MAX_ISSUES = 16;
const MAX_ISSUE_MESSAGE_LENGTH = 512;
const MAX_ISSUE_PATH_LENGTH = 256;

export function safeSchemaIssues(issues: readonly StandardSchemaV1.Issue[]): SafeSchemaIssue[] {
  return issues.slice(0, MAX_ISSUES).map((issue) => {
    const message =
      typeof issue.message === "string"
        ? issue.message.slice(0, MAX_ISSUE_MESSAGE_LENGTH)
        : "invalid value";
    const path = issuePath(issue.path);
    return path === undefined ? { message } : { message, path };
  });
}

function issuePath(path: StandardSchemaV1.Issue["path"]): string | undefined {
  if (!path || path.length === 0) return undefined;
  return path
    .map((segment) => {
      const key =
        typeof segment === "object" && segment !== null && "key" in segment ? segment.key : segment;
      return typeof key === "symbol" ? "<symbol>" : String(key);
    })
    .join(".")
    .slice(0, MAX_ISSUE_PATH_LENGTH);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function",
  );
}
