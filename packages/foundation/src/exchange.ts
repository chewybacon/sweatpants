import type { Operation } from "effection";

/** A live request/return capability. Neither this function nor its stack is persisted. */
export type Exchange<Request, Reply> = (request: Request) => Operation<Reply>;

export type Flow<Input, Output, Request, Reply> = (
  input: Input,
  exchange: Exchange<Request, Reply>,
) => Operation<Output>;

/** Middleware has activation-local lifetime; durable effects belong to the journal. */
export type ExchangeMiddleware<Request, Reply> = (
  next: Exchange<Request, Reply>,
) => Exchange<Request, Reply>;

export interface ExchangeSignature<Input, Output> {
  readonly input: Input;
  readonly output: Output;
}

/** Distribute the request over keys so union keys cannot lose input correlation. */
export type TypedExchangeRequest<
  M extends { [P in keyof M]: ExchangeSignature<unknown, unknown> },
  K extends keyof M & string = keyof M & string,
> = { [P in K]: { readonly binding: P; readonly site: string; readonly input: M[P]["input"] } }[K];

export type TypedExchange<M extends { [P in keyof M]: ExchangeSignature<unknown, unknown> }> = <
  K extends keyof M & string,
>(
  request: TypedExchangeRequest<M, K>,
) => Operation<M[K]["output"]>;
