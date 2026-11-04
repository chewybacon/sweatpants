import type { Api, Composition } from "@standard-durability/core";
import type {
  ContextCounter,
  ImageProvider,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from "./contracts.ts";
/** Construct the scoped provider facade. Subscriptions retain their acquisition scope/source. */
export function createModelProvider<
  Y,
  Request = ModelRequest,
  Event = ModelStreamEvent,
  Response = ModelResponse,
>(
  composition: Composition<Y>,
  name: string,
  driver: ModelProvider<Y, Request, Event, Response>,
): Api<ModelProvider<Y, Request, Event, Response>, Y> {
  return composition.createApi<ModelProvider<Y, Request, Event, Response>>(name, {
    operations: driver,
  });
}
/** Construct scoped image generation; installation changes subsequent calls only. */
export function createImageProvider<Y>(
  composition: Composition<Y>,
  name: string,
  driver: ImageProvider<Y>,
): Api<ImageProvider<Y>, Y> {
  return composition.createApi<ImageProvider<Y>>(name, {
    operations: driver,
  });
}
/** Bind a real tokenizer or an explicitly labelled estimator. No fabricated default count. */
export function createContextCounter<Y>(
  composition: Composition<Y>,
  name: string,
  driver: ContextCounter<Y>,
): Api<ContextCounter<Y>, Y> {
  return composition.createApi<ContextCounter<Y>>(name, {
    operations: driver,
  });
}
