import { createContext, type Operation, type Stream } from 'effection'
import type { Context, Model, StreamEvent, StreamOptions, AssistantMessage } from './runtime/types.ts'

export interface ModelProviderStreamRequest {
  model: Model
  context: Context
  options?: StreamOptions
}

export interface ModelProviderSampleRequest {
  model: Model
  context: Context
  options?: StreamOptions
}

export interface ModelProviderDriver {
  stream(request: ModelProviderStreamRequest): Stream<StreamEvent, AssistantMessage>
  sample(request: ModelProviderSampleRequest): Operation<AssistantMessage>
}

export const ModelProviderContext = createContext<ModelProviderDriver>('ModelProviderDriver')
export const ModelProviderModelContext = createContext<Model>('ModelProviderModel')
export const ModelProviderStreamOptionsContext = createContext<StreamOptions>('ModelProviderStreamOptions')

export const ModelProviderApi = {
  *stream(request: ModelProviderStreamRequest): Operation<Stream<StreamEvent, AssistantMessage>> {
    const driver = yield* ModelProviderContext.get()
    if (!driver) throw new Error('Model provider not configured. Install a ModelProviderDriver in scope.')
    return driver.stream(request)
  },
  *sample(request: ModelProviderSampleRequest): Operation<AssistantMessage> {
    const driver = yield* ModelProviderContext.get()
    if (!driver) throw new Error('Model provider not configured. Install a ModelProviderDriver in scope.')
    return yield* driver.sample(request)
  },
  *model(): Operation<Model> {
    const model = yield* ModelProviderModelContext.get()
    if (!model) throw new Error('Model provider model not configured. Set ModelProviderModelContext in scope.')
    return model
  },
  *streamOptions(): Operation<StreamOptions | undefined> {
    return yield* ModelProviderStreamOptionsContext.get()
  },
}
