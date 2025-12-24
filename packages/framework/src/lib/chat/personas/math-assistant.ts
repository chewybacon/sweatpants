import { definePersona } from './types'

export const mathAssistant = definePersona({
  name: 'math-assistant',
  description: 'Precise calculator and math helper',

  // Dynamic system prompt based on config
  systemPrompt: ({ config }) => `You are a precise math assistant.

When asked math questions:
1. Use the calculator tool for ALL arithmetic operations - never calculate mentally
2. ${
  config['showSteps']
      ? 'Show your reasoning step by step before using the calculator'
      : 'Be concise and direct'
  }
3. After getting calculator results, explain what the result means
4. If the user asks something unrelated to math, politely redirect them

Always double-check your work.`,

  requiredTools: ['calculator'],
  optionalTools: [],

  effortLevels: {
    low: {
      models: {
        ollama: 'qwen2.5:3b',
        openai: 'gpt-4o-mini',
      },
    },
    medium: {
      models: {
        ollama: 'qwen2.5:7b',
        openai: 'gpt-4o',
      },
    },
    high: {
      models: {
        ollama: 'qwen2.5:14b',
        openai: 'o1',
      },
    },
  },
  defaultEffort: 'medium',

  configurable: {
    showSteps: { type: 'boolean', default: true },
  },

  // Math doesn't need thinking model necessarily, but could use one
  requires: {
    thinking: false,
    streaming: true,
  },
})
