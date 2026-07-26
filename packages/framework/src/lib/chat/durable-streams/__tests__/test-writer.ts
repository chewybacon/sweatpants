import type { Operation } from "effection";
import type { TokenBuffer, TokenBufferWriter } from "@sweatpants/durable-streams";

export function* testWriter<T>(buffer: TokenBuffer<T>): Operation<TokenBufferWriter<T>> {
  return yield* buffer.claimWriter({ ownerId: `test:${buffer.id}`, activationEpoch: 1 });
}

export function* appendTestTokens<T>(buffer: TokenBuffer<T>, tokens: T[]): Operation<number> {
  return yield* (yield* testWriter(buffer)).append(tokens);
}

export function* completeTestBuffer<T>(buffer: TokenBuffer<T>): Operation<void> {
  yield* (yield* testWriter(buffer)).complete();
}

export function* failTestBuffer<T>(buffer: TokenBuffer<T>, error: Error): Operation<void> {
  yield* (yield* testWriter(buffer)).fail(error);
}
