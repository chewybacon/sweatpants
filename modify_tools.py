import sys

f1_path = "packages/framework/src/lib/chat/isomorphic-tools/builder.ts"
f2_path = "packages/framework/src/handler/durable/chat-engine.ts"

# 1. Update builder.ts
with open(f1_path, "r", encoding="utf-8") as f:
    f1_content = f.read()

replacement1_1 = """  /**
   * Client-only execution.
   * Client runs and its output is sent directly to the LLM.
   */
  client<TClientOutput>(
    fn: (
      input: undefined,
      ctx: ContextForMode<TContext>,
      params: TParams
    ) => Operation<TClientOutput>
  ): FinalizedIsomorphicTool<TName, TParams, TContext, undefined, TClientOutput, TClientOutput>

  /**
   * Set approval configuration.
   */
  approval(config: IsomorphicApprovalConfig): this"""

search1_1 = """  /**
   * Set approval configuration.
   */
  approval(config: IsomorphicApprovalConfig): this"""

f1_content = f1_content.replace(search1_1, replacement1_1, 1)

replacement1_2 = """    client(fn: (input: any, ctx: any, params: any) => Operation<any>) {
      if (!state.contextMode) {
        throw new Error(`Tool "${state.name}": .context() must be called before .client()`)
      }
      return {
        _types: undefined as any,
        name: state.name,
        description: state.description!,
        parameters: state.parameters!,
        contextMode: state.contextMode,
        approval: state.approval,
        client: fn,
      } as FinalizedIsomorphicTool<any, any, any, any, any, any>
    },"""

search1_2 = """    client() {
      throw new Error(`Tool "${state.name}": .server() must be called before .client()`)
    },"""

f1_content = f1_content.replace(search1_2, replacement1_2, 1)

with open(f1_path, "w", encoding="utf-8") as f:
    f.write(f1_content)


# 2. Update chat-engine.ts
with open(f2_path, "r", encoding="utf-8") as f:
    f2_content = f.read()

search2 = """    if (!tool.server) {
      return {
        ok: false,
        error: {
          callId: toolCall.id,
          toolName,
          message: `Tool "${toolName}" has no server function`,
        },
      }
    }"""

replacement2 = """    if (!tool.server) {
      if (tool.client) {
        return {
          ok: true,
          kind: 'handoff',
          callId: toolCall.id,
          toolName,
          handoff: {
            type: 'isomorphic_handoff',
            callId: toolCall.id,
            toolName,
            params: validatedParams,
            serverOutput: undefined,
            usesHandoff: false,
          },
          serverOutput: undefined,
        }
      }

      return {
        ok: false,
        error: {
          callId: toolCall.id,
          toolName,
          message: `Tool "${toolName}" has no server function`,
        },
      }
    }"""

f2_content = f2_content.replace(search2, replacement2, 1)

with open(f2_path, "w", encoding="utf-8") as f:
    f.write(f2_content)

print("Modifications applied successfully.")
