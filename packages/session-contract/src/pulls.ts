import type { Operation } from 'effection'

import type { Json, PullDescriptor } from './types.ts'

export type RecordProducer = (input: Json, context: { pullId: string }) => Operation<Json> | Json
const producers = new WeakMap<PullDescriptor, RecordProducer>()

export function* effect<T extends Json = Json>(effectId: string, input: Json): Generator<PullDescriptor, T, unknown> {
  return (yield { kind: 'effect', effectId, input }) as T
}

export function* sample<T extends Json = Json>(input: Json): Generator<PullDescriptor, T, unknown> {
  return yield* effect<T>('model.sample', input)
}

export function* elicit<T extends Json = Json>(
  effectId: string,
  input: { key: string; message: string; responseSchema: Json; context?: Json },
): Generator<PullDescriptor, T, unknown> {
  return (yield { kind: 'elicit', effectId, input }) as T
}

export function* record<T extends Json = Json>(
  effectId: string,
  input: Json,
  producer: (input: Json, context: { pullId: string }) => Operation<T> | T,
): Generator<PullDescriptor, T, unknown> {
  const descriptor: PullDescriptor = { kind: 'record', effectId, input }
  producers.set(descriptor, producer as RecordProducer)
  return (yield descriptor) as T
}

export function* invoke<T extends Json = Json>(programId: string, input: Json): Generator<PullDescriptor, T, unknown> {
  return (yield { kind: 'invoke', programId, input }) as T
}

export function* call<T extends Json = Json>(toolName: string, input: Json): Generator<PullDescriptor, T, unknown> {
  return yield* invoke<T>(toolName.startsWith('tool.') ? toolName : `tool.${toolName}`, input)
}

export function* all<T extends readonly Json[] = readonly Json[]>(
  children: ReadonlyArray<{ programId: string; input: Json }>,
): Generator<PullDescriptor, T, unknown> {
  return (yield { kind: 'all', children }) as unknown as T
}

export function* emit(eventType: string, payload: Json): Generator<PullDescriptor, void, unknown> {
  yield { kind: 'emit', eventType, payload }
}

export function recordProducerFor(descriptor: PullDescriptor): RecordProducer | undefined {
  return producers.get(descriptor)
}
