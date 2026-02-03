/**
 * Calculator Tool
 *
 * A simple server-only tool that evaluates mathematical expressions.
 * Demonstrates the basic tool pattern with file-based discovery.
 */
import { createTool } from '@sweatpants/framework/chat/tools'
import { z } from 'zod'

export const calculator = createTool('calculator')
  .description('Evaluate a mathematical expression')
  .parameters(
    z.object({
      expression: z.string().describe('The mathematical expression to evaluate'),
    })
  )
  .execute(function* (params) {
    // Simple expression evaluator (in production, use a proper math parser)
    try {
      // Only allow safe math operations
      const sanitized = params.expression.replace(/[^0-9+\-*/().%\s]/g, '')
      if (sanitized !== params.expression) {
        return {
          error: 'Invalid characters in expression',
          result: null,
        }
      }

      // eslint-disable-next-line no-eval
      const result = eval(sanitized)

      return {
        expression: params.expression,
        result: typeof result === 'number' ? result : null,
        error: null,
      }
    } catch (e) {
      return {
        expression: params.expression,
        result: null,
        error: e instanceof Error ? e.message : 'Unknown error',
      }
    }
  })
