/**
 * settlers/index.ts
 *
 * Built-in settlers for the rendering buffer.
 *
 * A settler decides when and what content should move from pending to settled.
 * It yields the content to settle, elegantly combining "when" and "what".
 */

// Individual settlers
export { paragraph } from './paragraph'
export { line } from './line'
export { sentence } from './sentence'
export { timeout } from './timeout'
export { maxSize } from './max-size'
export { codeFence, type CodeFenceMeta } from './code-fence'

// Combinators
export { any, all } from './combinators'

// Re-export types
export type {
  Settler,
  MetadataSettler,
  SettlerFactory,
  SettleContext,
  SettleResult,
  SettleMeta,
  BaseSettleMeta,
} from '../types/settler'

// Default settler factory
import { paragraph } from './paragraph'
export const defaultSettlerFactory = paragraph
