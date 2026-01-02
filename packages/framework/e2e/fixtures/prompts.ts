/**
 * Deterministic Test Prompts
 *
 * These prompts are designed to elicit predictable responses from the LLM,
 * making tests more reliable and less flaky.
 *
 * Key principles:
 * 1. Ask for specific, verifiable output (numbers, simple facts)
 * 2. Constrain the response format
 * 3. Avoid open-ended questions
 */

/**
 * Simple prompts that should produce short, predictable responses.
 */
export const simplePrompts = {
  /**
   * Ask for a simple math calculation - response should contain "4".
   */
  whatIsTwoPlusTwo: 'What is 2 + 2? Reply with just the number.',

  /**
   * Ask for a single word - response should contain "blue" or "sky".
   */
  colorOfSky: 'What color is the sky? Reply with a single word.',

  /**
   * Ask for a yes/no answer - response should contain "yes".
   */
  isWaterWet: 'Is water wet? Reply with just yes or no.',

  /**
   * Ask for a simple fact - response should mention the number of continents.
   */
  howManyContinents: 'How many continents are there on Earth? Reply with just the number.',

  /**
   * Echo back - response should contain exactly "hello".
   */
  echoHello: 'Say exactly "hello" and nothing else.',
} as const

/**
 * Prompts designed to trigger markdown rendering.
 */
export const markdownPrompts = {
  /**
   * Request a list - should produce markdown list items.
   */
  simpleList: `List 3 primary colors in a markdown bullet list format:
- First color
- Second color
- Third color

Be concise.`,

  /**
   * Request bold text - should produce **bold** markdown.
   */
  boldText: 'Write the word "important" in bold markdown format only.',

  /**
   * Request a code block - should produce fenced code.
   */
  codeBlock: `Write a simple JavaScript hello world in a code block:
\`\`\`javascript
// Your code here
\`\`\``,

  /**
   * Request a heading - should produce a markdown heading.
   */
  heading: 'Write "Test Heading" as a markdown level 2 heading and nothing else.',
} as const

/**
 * Prompts designed to trigger tool usage.
 * These depend on specific tools being available.
 */
export const toolPrompts = {
  /**
   * Calculator tool prompt - should trigger calculator tool.
   */
  useCalculator: 'Use the calculator tool to compute 15 * 7.',

  /**
   * Pick card tool prompt - should trigger pick card tool.
   */
  pickCard: 'Use the pick card tool to let me pick a card.',

  /**
   * Weather tool prompt - should trigger weather tool.
   */
  getWeather: 'What is the weather in San Francisco? Use the weather tool.',
} as const

/**
 * Prompts for multi-turn conversation testing.
 */
export const multiTurnPrompts = {
  /**
   * First message establishing context.
   */
  setContext: 'Remember this number: 42. Say "I will remember 42" and nothing else.',

  /**
   * Follow-up asking about the context.
   */
  recallContext: 'What number did I ask you to remember? Reply with just the number.',

  /**
   * First message of a series.
   */
  countStart: 'I will count. Say "1" and nothing else.',

  /**
   * Continue counting.
   */
  countContinue: 'Continue counting from where you left off. Say just the next number.',
} as const

/**
 * All prompts combined for easy access.
 */
export const prompts = {
  simple: simplePrompts,
  markdown: markdownPrompts,
  tool: toolPrompts,
  multiTurn: multiTurnPrompts,
} as const

export default prompts
