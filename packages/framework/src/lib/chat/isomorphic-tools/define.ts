/**
 * Factory functions for defining isomorphic tools.
 *
 * KEY PRINCIPLE: Server's return value is ALWAYS the final result to the LLM.
 * There is no "merge" function.
 *
 * Type inference based on authority mode:
 * - `client` authority: Client output flows to server input, server returns final result
 * - `server` authority: Server can use ctx.handoff() to yield to client, server returns final result
 */
import type { z } from 'zod'
import type {
  ServerAuthorityToolDef,
  ClientAuthorityToolDef,
  AnyIsomorphicTool,
  IsomorphicApprovalConfig,
} from './types'

// --- Overloaded Factory Function ---

/**
 * Define an isomorphic tool with type-safe server↔client data flow.
 *
 * @example Client-authority tool (client output → server validation)
 * ```typescript
 * const getUserChoice = defineIsomorphicTool({
 *   name: 'get_user_choice',
 *   description: 'Get a choice from the user',
 *   parameters: z.object({ options: z.array(z.string()) }),
 *   authority: 'client',
 *
 *   // Client runs first - collect user input
 *   *client(params, ctx) {
 *     const choice = yield* showChoiceDialog(params.options)
 *     return { choice }
 *     //       ^^^^^^ This flows to server!
 *   },
 *
 *   // Server runs second - validates and returns final result for LLM
 *   *server(params, ctx, clientOutput) {
 *     // clientOutput is typed as { choice: string }
 *     const isValid = params.options.includes(clientOutput.choice)
 *     return { validated: isValid, choice: clientOutput.choice }
 *     //       ^^^^^^^^^ This is what the LLM sees
 *   },
 * })
 * ```
 *
 * @example Server-authority tool with handoff (server yields to client)
 * ```typescript
 * const pickCard = defineIsomorphicTool({
 *   name: 'pick_card',
 *   description: 'Pick a secret card and have user guess',
 *   parameters: z.object({ difficulty: z.enum(['easy', 'hard']) }),
 *   authority: 'server',
 *
 *   // Server picks card, hands off to client, then validates guess
 *   *server(params, ctx) {
 *     return yield* ctx.handoff({
 *       *before() {
 *         const secret = pickRandomCard(params.difficulty)
 *         return { secret, hint: 'Guess my card!' }
 *       },
 *       *after(handoff, client: { guess: string }) {
 *         return {
 *           secret: handoff.secret,
 *           guess: client.guess,
 *           correct: client.guess === handoff.secret,
 *         }
 *       },
 *     })
 *   },
 *
 *   // Client shows UI for guessing
 *   *client(handoffData, ctx, params) {
 *     // handoffData is { secret, hint } from before()
 *     const guess = yield* showGuessDialog(handoffData.hint)
 *     return { guess }
 *   },
 * })
 * ```
 *
 * @example Simple server-authority tool (no handoff needed)
 * ```typescript
 * const celebrate = defineIsomorphicTool({
 *   name: 'celebrate',
 *   description: 'Celebrate with confetti',
 *   parameters: z.object({ message: z.string() }),
 *   authority: 'server',
 *
 *   // Server just returns result
 *   *server({ message }) {
 *     return { celebrated: true, message }
 *   },
 *
 *   // Client shows the celebration
 *   *client(serverOutput, ctx) {
 *     showConfetti(serverOutput.message)
 *     return { displayed: true }
 *   },
 * })
 * ```
 */

// Overload 1: Server authority
export function defineIsomorphicTool<
  TParams extends z.ZodType,
  TServerOutput,
  TClientOutput,
>(
  def: ServerAuthorityToolDef<TParams, TServerOutput, TClientOutput>
): ServerAuthorityToolDef<TParams, TServerOutput, TClientOutput>

// Overload 2: Client authority
export function defineIsomorphicTool<
  TParams extends z.ZodType,
  TServerOutput,
  TClientOutput,
>(
  def: ClientAuthorityToolDef<TParams, TServerOutput, TClientOutput>
): ClientAuthorityToolDef<TParams, TServerOutput, TClientOutput>


// Implementation
export function defineIsomorphicTool(
  def: AnyIsomorphicTool
): AnyIsomorphicTool {
  // Apply defaults
  return {
    authority: 'server',
    approval: {
      server: 'none',
      client: 'confirm',
      onDenied: 'error',
      ...def.approval,
    } as IsomorphicApprovalConfig,
    ...def,
  }
}

// --- Server-Only Helper ---

/**
 * Define a server-authority tool (most common case).
 *
 * This is a convenience wrapper for `defineIsomorphicTool` with
 * `authority: 'server'` preset.
 */
export function defineServerTool<
  TParams extends z.ZodType,
  TServerOutput,
  TClientOutput,
>(
  def: Omit<ServerAuthorityToolDef<TParams, TServerOutput, TClientOutput>, 'authority'>
): ServerAuthorityToolDef<TParams, TServerOutput, TClientOutput> {
  return defineIsomorphicTool({
    ...def,
    authority: 'server',
  } as ServerAuthorityToolDef<TParams, TServerOutput, TClientOutput>)
}

// --- Client-First Helper ---

/**
 * Define a client-authority tool.
 *
 * Use when the client needs to collect user input before
 * the server can validate or process.
 */
export function defineClientFirstTool<
  TParams extends z.ZodType,
  TServerOutput,
  TClientOutput,
>(
  def: Omit<ClientAuthorityToolDef<TParams, TServerOutput, TClientOutput>, 'authority'>
): ClientAuthorityToolDef<TParams, TServerOutput, TClientOutput> {
  return defineIsomorphicTool({
    ...def,
    authority: 'client',
  } as ClientAuthorityToolDef<TParams, TServerOutput, TClientOutput>)
}

