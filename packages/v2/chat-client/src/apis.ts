import type { Api, Composition } from "@standard-durability/core";
import type { ElicitationHandler, ResponseSubscriptions } from "./contracts.ts";
/** Scoped response-source selection. Existing handles keep their acquisition source/lifetime. */
export function createResponseSubscriptions<Cursor, Frame, Close, Y>(
  composition: Composition<Y>,
  name: string,
  driver: ResponseSubscriptions<Cursor, Frame, Close, Y>,
): Api<ResponseSubscriptions<Cursor, Frame, Close, Y>, Y> {
  return composition.createApi<ResponseSubscriptions<Cursor, Frame, Close, Y>>(name, {
    operations: driver,
  });
}
/** Typed client handler seam, independent of executable tool definitions or reply cache ownership. */
export function createElicitationHandler<C, O, E, Y>(
  composition: Composition<Y>,
  name: string,
  driver: ElicitationHandler<C, O, E, Y>,
): Api<ElicitationHandler<C, O, E, Y>, Y> {
  return composition.createApi<ElicitationHandler<C, O, E, Y>>(name, {
    operations: driver,
  });
}
