/**
 * settlers.ts
 *
 * Re-exports from the settlers/ directory for backward compatibility.
 * New code should import from './settlers/index'.
 */

export * from './settlers/index'

// Legacy alias
import { codeFence } from './settlers/code-fence'
export const defaultMetadataSettlerFactory = codeFence
