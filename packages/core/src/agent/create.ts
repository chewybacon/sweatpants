import { createContext, scoped } from "effection";
import type { Operation } from "effection";
import type { ZodSchema, infer as ZodInfer, input as ZodInput } from "zod";
import type {
  AgentConfig,
  Agent,
  AgentFactory,
  AgentFactoryWithConfig,
  AgentFactoryWithoutConfig,
  AgentMiddleware,
  AnyToolFactory,
} from "./types.ts";

/**
 * Creates an agent that groups related tools with optional shared configuration.
 *
 * @example
 * ```ts
 * // Agent without config
 * const SimpleAgent = createAgent({
 *   name: "simple",
 *   description: "A simple agent",
 *   tools: { search: Search },
 * });
 *
 * const agent = yield* SimpleAgent();
 * yield* agent.search({ query: "hello" });
 *
 * // Agent with config
 * const FlightAgent = createAgent({
 *   name: "flight",
 *   description: "Flight booking agent",
 *   config: z.object({
 *     apiKey: z.string(),
 *     baseUrl: z.string().default("https://api.flights.com"),
 *   }),
 *   tools: { search: Search, book: Book },
 * });
 *
 * const flight = yield* FlightAgent({ apiKey: "sk-..." });
 * yield* flight.search({ destination: "Tokyo" });
 *
 * // Tool accessing config
 * const Search = createTool({
 *   name: "search",
 *   impl: function* (args, send) {
 *     const config = yield* FlightAgent.useConfig();
 *     // config is typed as { apiKey: string; baseUrl: string }
 *   },
 * });
 * ```
 */
// Overload for agent WITH config
export function createAgent<
  TConfig extends ZodSchema,
  TTools extends Record<string, AnyToolFactory>,
>(
  agentConfig: AgentConfig<TConfig, TTools> & { config: TConfig },
): AgentFactoryWithConfig<TConfig, TTools>;

// Overload for agent WITHOUT config
export function createAgent<
  TTools extends Record<string, AnyToolFactory>,
>(
  agentConfig: AgentConfig<undefined, TTools>,
): AgentFactoryWithoutConfig<TTools>;

// Implementation
export function createAgent<
  TConfig extends ZodSchema | undefined,
  TTools extends Record<string, AnyToolFactory>,
>(
  agentConfig: AgentConfig<TConfig, TTools>,
): AgentFactory<TConfig, TTools> {
  // Create config context unique to this agent
  // This will be used by useConfig() to retrieve the config
  const configContext = createContext<ZodInfer<NonNullable<TConfig>>>(
    `agent.${agentConfig.name}.config`,
  );

  /**
   * Factory function to activate the agent.
   * Creates a scoped context where config is set and tools are activated.
   */
  function factory(inputConfig?: ZodInput<NonNullable<TConfig>>): Operation<Agent<TTools>> {
    return scoped(function* () {
      // Validate and set config if schema exists
      if (agentConfig.config) {
        const validated = agentConfig.config.parse(inputConfig) as ZodInfer<
          NonNullable<TConfig>
        >;
        yield* configContext.set(validated);
      }

      // Activate all tools within this scope
      const agent = {} as Agent<TTools>;

      for (const toolName of Object.keys(agentConfig.tools) as Array<keyof TTools>) {
        const toolFactory = agentConfig.tools[toolName];
        // Activate tool (call factory with no args to use default impl or transport routing)
        const activatedTool = yield* (toolFactory as () => Operation<unknown>)();
        agent[toolName] = activatedTool as Agent<TTools>[typeof toolName];
      }

      return agent;
    });
  }

  /**
   * Access agent config from within a tool.
   * Must be called within the agent's scope (i.e., after activation).
   * Throws if called outside agent scope or if agent has no config schema.
   */
  function useConfig(): Operation<ZodInfer<NonNullable<TConfig>>> {
    return {
      *[Symbol.iterator]() {
        if (!agentConfig.config) {
          throw new Error(
            `Agent "${agentConfig.name}" does not have a config schema. ` +
              `Define a config schema in createAgent() to use useConfig().`,
          );
        }
        return yield* configContext.expect();
      },
    };
  }

  /**
   * Register middleware for the agent's tools.
   * Delegates to each tool's decorate() method.
   */
  function decorate(
    middleware: Partial<AgentMiddleware<TTools>>,
  ): Operation<void> {
    return {
      *[Symbol.iterator]() {
        for (const toolName of Object.keys(middleware) as Array<keyof TTools>) {
          const toolMiddleware = middleware[toolName];
          if (toolMiddleware) {
            const toolFactory = agentConfig.tools[toolName];
            if (toolFactory) {
              yield* toolFactory.decorate(toolMiddleware);
            }
          }
        }
      },
    };
  }

  // Attach methods and properties to factory
  // Use Object.defineProperty for readonly properties
  Object.defineProperty(factory, "useConfig", {
    value: useConfig,
    writable: false,
    enumerable: true,
  });
  Object.defineProperty(factory, "decorate", {
    value: decorate,
    writable: false,
    enumerable: true,
  });
  Object.defineProperty(factory, "tools", {
    value: agentConfig.tools,
    writable: false,
    enumerable: true,
  });
  Object.defineProperty(factory, "name", {
    value: agentConfig.name,
    writable: false,
    enumerable: true,
  });
  Object.defineProperty(factory, "description", {
    value: agentConfig.description,
    writable: false,
    enumerable: true,
  });

  return factory as AgentFactory<TConfig, TTools>;
}
