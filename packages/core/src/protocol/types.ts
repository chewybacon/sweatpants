import type { Operation, Stream } from "effection";
import type { ZodSchema, infer as ZodInfer } from "zod";

// ============================================================================
// Method Definition
// ============================================================================

/**
 * A method definition with input, progress, and output schemas.
 * Methods are the building blocks of a protocol.
 */
export interface Method<
  TInput extends ZodSchema = ZodSchema,
  TProgress extends ZodSchema = ZodSchema,
  TOutput extends ZodSchema = ZodSchema,
> {
  /** Schema for method arguments */
  input: TInput;
  /** Schema for progress updates (use z.never() if none) */
  progress: TProgress;
  /** Schema for return value */
  output: TOutput;
}

/**
 * A record of method names to method definitions.
 */
export type Methods = Record<string, Method>;

// ============================================================================
// Protocol
// ============================================================================

/**
 * A protocol defines a set of methods that can be invoked.
 * The protocol itself is just a schema - it doesn't include implementation.
 */
export interface Protocol<M extends Methods> {
  /** The methods defined by this protocol */
  methods: M;
}

// ============================================================================
// Invocation
// ============================================================================

/**
 * Arguments for invoking a method on a protocol.
 */
export interface InvocationArgs<M extends Methods, N extends keyof M = keyof M> {
  /** The method name to invoke */
  name: N;
  /** The arguments to pass to the method */
  args: ZodInfer<M[N]["input"]>;
}

/**
 * The result of invoking a method - a stream of progress updates
 * that closes with the final result.
 */
export type InvocationResult<M extends Methods, N extends keyof M = keyof M> = Stream<
  ZodInfer<M[N]["progress"]>,
  ZodInfer<M[N]["output"]>
>;

// ============================================================================
// Method Handler
// ============================================================================

/**
 * A handler function for a single method.
 * Takes input args and returns a stream of progress/result.
 */
export type MethodHandler<M extends Methods, N extends keyof M> = 
  (args: ZodInfer<M[N]["input"]>) => Stream<ZodInfer<M[N]["progress"]>, ZodInfer<M[N]["output"]>>;

/**
 * A record of method handlers matching a protocol's methods.
 */
export type MethodHandlers<M extends Methods> = {
  [N in keyof M]: (args: ZodInfer<M[N]["input"]>) => Stream<
    ZodInfer<M[N]["progress"]>,
    ZodInfer<M[N]["output"]>
  >;
};

// ============================================================================
// Implementation
// ============================================================================

/**
 * An implementation is an operation that yields method handlers.
 * This allows handlers to be set up with access to the current scope/context.
 */
export type Implementation<M extends Methods> = () => Operation<MethodHandlers<M>>;

// ============================================================================
// Handle
// ============================================================================

/**
 * A handle provides runtime access to invoke protocol methods.
 * This is what you get after attaching an implementation.
 */
export interface Handle<M extends Methods> {
  /** The protocol this handle implements */
  protocol: Protocol<M>;
  
  /** The method handlers */
  methods: MethodHandlers<M>;
  
  /** Invoke a method by name with arguments */
  invoke<N extends keyof M>(args: InvocationArgs<M, N>): InvocationResult<M, N>;
}

// ============================================================================
// Inspector
// ============================================================================

/**
 * An inspector combines a protocol with an implementation.
 * Call attach() to get a handle for invoking methods.
 */
export interface Inspector<M extends Methods> {
  /** The protocol definition */
  protocol: Protocol<M>;
  
  /** Attach the implementation and get a handle */
  attach(): Operation<Handle<M>>;
}
