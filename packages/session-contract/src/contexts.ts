import { createContext, type Operation } from 'effection'

import {
  SessionContractError,
  type CapabilityResolver,
  type ModelProvider,
  type PostOrphanPolicy,
} from './types.ts'

export const CapabilityResolverContext = createContext<CapabilityResolver | undefined>(
  'session-contract:resolver',
  undefined,
)

export const ModelProviderContext = createContext<ModelProvider | undefined>(
  'session-contract:model-provider',
  undefined,
)

export const PostOrphanPolicyContext = createContext<PostOrphanPolicy | undefined>(
  'session-contract:post-orphan-policy',
  undefined,
)

export function* useCapabilityResolver(): Operation<CapabilityResolver> {
  const resolver = yield* CapabilityResolverContext.get()
  if (!resolver) {
    throw new SessionContractError('unknown_target', 'No capability resolver is bound in scope')
  }
  return resolver
}

export function* useModelProvider(): Operation<ModelProvider> {
  const provider = yield* ModelProviderContext.get()
  if (!provider) {
    throw new SessionContractError('unsupported_operation', 'No model provider is bound in scope')
  }
  return provider
}

export function* usePostOrphanPolicy(): Operation<PostOrphanPolicy> {
  return (yield* PostOrphanPolicyContext.get()) ?? 'park'
}
