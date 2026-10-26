import type { Api, Operation } from "./contracts.js";
import type {
  ApiDefinition,
  InputOf,
  OperationDefinitions,
  Outcome,
  OutcomeOf,
  Signature,
} from "./api-definition.js";

/** Dispatch metadata, independent of serialization, transport correlation and journal identity. */
export type ApiRequest<Wire> = {
  readonly kind: "api";
  readonly api: string;
  readonly method: string;
  readonly version: string;
  readonly input: Wire;
  readonly retrySafety: { readonly mode: "repeatable" | "unsafe" };
};
export type GuestOperations<D extends OperationDefinitions, Wire> = {
  readonly [K in keyof D]: (input: InputOf<D[K]>) => Operation<OutcomeOf<D[K]>, ApiRequest<Wire>>;
};
export interface HostBinding<D extends OperationDefinitions, Y, Wire> extends Api<Signature<D>, Y> {
  /** Validates dispatch metadata and final domain outcome; persistence is owned separately. */
  dispatch(request: ApiRequest<Wire>): Operation<Outcome<unknown, unknown>, Y>;
}
export interface Host<Y, Wire> {
  use<D extends OperationDefinitions>(definition: ApiDefinition<D>): HostBinding<D, Y, Wire>;
}
