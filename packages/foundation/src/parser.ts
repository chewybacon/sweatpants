import type { StandardSchemaV1 } from "@standard-schema/spec";

const MAX_ISSUES = 16;
const MAX_ISSUE_MESSAGE_LENGTH = 512;
const MAX_ISSUE_PATH_LENGTH = 256;
const MAX_ISSUE_CODE_LENGTH = 128;

export interface Parser<T> {
  parse(input: unknown): ParseResult<T>;

  map<U>(transform: (value: T) => U): Parser<U>;

  andThen<U>(next: (value: T) => ParseResult<U>): Parser<U>;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ParseIssue[] };

export interface ParseIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly code?: string;
}

export type SchemaImplementationErrorReason = "validator-threw" | "async-unsupported";

/** A validator violated the synchronous Standard Schema contract. */
export class SchemaImplementationError extends TypeError {
  readonly reason: SchemaImplementationErrorReason;

  constructor(reason: SchemaImplementationErrorReason) {
    super(
      reason === "async-unsupported"
        ? "Synchronous parser validation does not support asynchronous validators"
        : "Standard Schema validator failed",
    );
    this.name = "SchemaImplementationError";
    this.reason = reason;
  }
}

export type AuthoredValidationResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "invalid"; readonly issues: readonly ParseIssue[] }
  | {
      readonly status: "schema-error";
      readonly reason: "invalid-interface" | SchemaImplementationErrorReason;
    };

/** Builds a synchronous parser around a Standard Schema V1 validator. */
export function parser<Input = unknown, Output = Input>(
  schema: StandardSchemaV1<Input, Output>,
): Parser<Output> {
  return parserFromParse((input) => {
    const result = validateStandardSchema(schema, input as Input);
    if (result.issues !== undefined) {
      return failure(convertIssues(result.issues));
    }
    return success(result.value);
  });
}

/** Creates a successful parser result for a typed semantic verifier. */
export function success<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

/** Creates a failed parser result for a typed semantic verifier. */
export function failure<T = never>(issue: ParseIssue | readonly ParseIssue[]): ParseResult<T> {
  const issues = Array.isArray(issue) ? issue : [issue];
  return { ok: false, issues: Object.freeze([...issues]) };
}

/**
 * Runs Standard Schema V1 validation without allowing a Promise to escape.
 * Invalid input is represented by the Standard Schema result. A broken
 * validator is represented by SchemaImplementationError.
 */
export function validateStandardSchema<Input = unknown, Output = unknown>(
  schema: StandardSchemaV1<Input, Output>,
  value: Input,
): StandardSchemaV1.Result<Output> {
  try {
    const standard = (schema as unknown as { readonly "~standard"?: unknown })["~standard"];
    if (
      !isRecord(standard) ||
      standard["version"] !== 1 ||
      typeof standard["validate"] !== "function"
    ) {
      throw new SchemaImplementationError("validator-threw");
    }

    const result = (standard["validate"] as (input: unknown) => unknown)(value);
    if (isPromiseLike(result)) {
      throw new SchemaImplementationError("async-unsupported");
    }
    if (!isRecord(result)) {
      throw new SchemaImplementationError("validator-threw");
    }
    if ("issues" in result) {
      if (!Array.isArray(result["issues"])) {
        throw new SchemaImplementationError("validator-threw");
      }
      return result as unknown as StandardSchemaV1.FailureResult;
    }
    if ("value" in result) {
      return result as unknown as StandardSchemaV1.SuccessResult<Output>;
    }
    throw new SchemaImplementationError("validator-threw");
  } catch (error) {
    if (error instanceof SchemaImplementationError) {
      throw error;
    }
    throw new SchemaImplementationError("validator-threw");
  }
}

/** Runs a replaceable authored schema and separates bad input from bad schema code. */
export function validateAuthoredSchema<Output = unknown>(
  schema: unknown,
  value: unknown,
): AuthoredValidationResult<Output> {
  if (!isStandardSchemaV1(schema)) {
    return { status: "schema-error", reason: "invalid-interface" };
  }
  try {
    const result = validateStandardSchema(schema, value);
    if (result.issues !== undefined) {
      return { status: "invalid", issues: convertIssues(result.issues) };
    }
    return { status: "ok", value: result.value as Output };
  } catch (error) {
    if (error instanceof SchemaImplementationError) {
      return { status: "schema-error", reason: error.reason };
    }
    return { status: "schema-error", reason: "validator-threw" };
  }
}

/** A bounded, vendor-neutral issue projection for existing boundary messages. */
export interface SafeSchemaIssue {
  readonly message: string;
  readonly path?: string;
  readonly code?: string;
}

export function safeSchemaIssues(
  issues: readonly StandardSchemaV1.Issue[] | readonly ParseIssue[],
): SafeSchemaIssue[] {
  return convertIssues(issues).map((issue) => ({
    message: issue.message,
    ...(issue.path.length > 0 ? { path: issue.path.map(String).join(".") } : {}),
    ...(issue.code === undefined ? {} : { code: issue.code }),
  }));
}

function parserFromParse<T>(parse: (input: unknown) => ParseResult<T>): Parser<T> {
  return {
    parse,
    map<U>(transform: (value: T) => U): Parser<U> {
      return parserFromParse((input) => {
        const result = parse(input);
        if (!result.ok) return result;
        return success(transform(result.value));
      });
    },
    andThen<U>(next: (value: T) => ParseResult<U>): Parser<U> {
      return parserFromParse((input) => {
        const result = parse(input);
        if (!result.ok) return result;
        return next(result.value);
      });
    },
  };
}

function convertIssues(
  issues: readonly StandardSchemaV1.Issue[] | readonly ParseIssue[],
): ParseIssue[] {
  return issues.slice(0, MAX_ISSUES).map((issue) => {
    const source = issue as StandardSchemaV1.Issue & Partial<ParseIssue>;
    const path = normalizePath(source.path);
    const message =
      typeof source.message === "string"
        ? source.message.slice(0, MAX_ISSUE_MESSAGE_LENGTH)
        : "invalid value";
    const code =
      typeof source.code === "string" ? source.code.slice(0, MAX_ISSUE_CODE_LENGTH) : undefined;
    return Object.freeze({
      path: Object.freeze(path),
      message,
      ...(code === undefined ? {} : { code }),
    });
  });
}

function normalizePath(path: unknown): Array<string | number> {
  if (!Array.isArray(path) || path.length === 0) return [];
  const result: Array<string | number> = [];
  let length = 0;
  for (const segment of path) {
    const key = isRecord(segment) && "key" in segment ? segment["key"] : segment;
    const normalized = normalizePathSegment(key);
    const text = String(normalized);
    const separatorLength = result.length === 0 ? 0 : 1;
    const available = MAX_ISSUE_PATH_LENGTH - length - separatorLength;
    if (available <= 0) break;
    if (text.length > available) {
      result.push(
        typeof normalized === "number" && available >= text.length
          ? normalized
          : text.slice(0, available),
      );
      break;
    }
    result.push(normalized);
    length += separatorLength + text.length;
  }
  return result;
}

function normalizePathSegment(value: unknown): string | number {
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "symbol") return "<symbol>";
  return "<path>";
}

function isStandardSchemaV1(value: unknown): value is StandardSchemaV1 {
  if (!isRecord(value) || !isRecord(value["~standard"])) return false;
  const standard = value["~standard"];
  return standard["version"] === 1 && typeof standard["validate"] === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false;
  }
  return typeof (value as { readonly then?: unknown }).then === "function";
}
