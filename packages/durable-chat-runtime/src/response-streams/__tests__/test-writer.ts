import type { Operation } from "effection";
import type { TokenBuffer, TokenBufferWriter } from "@sweatpants/durable-streams";

export function* testWriter<T>(buffer: TokenBuffer<T>): Operation<TokenBufferWriter<T>> {
  return yield* buffer.claimWriter({ ownerId: `test:${buffer.id}`, activationEpoch: 1 });
}

export function* appendTestTokens<T>(buffer: TokenBuffer<T>, tokens: T[]): Operation<number> {
  const writer = yield* testWriter(buffer);
  return yield* writer.append(tokens);
}

export function* completeTestBuffer<T>(buffer: TokenBuffer<T>): Operation<void> {
  const writer = yield* testWriter(buffer);
  yield* writer.complete();
}

export function* failTestBuffer<T>(buffer: TokenBuffer<T>, error: Error): Operation<void> {
  const writer = yield* testWriter(buffer);
  yield* writer.fail(error);
}
