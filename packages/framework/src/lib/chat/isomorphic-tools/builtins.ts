import { sleep } from 'effection'
import { z } from 'zod'

import { createIsomorphicTool } from './builder'

export const calculatorIsomorphicTool = createIsomorphicTool('calculator')
  .description('Perform basic arithmetic calculations')
  .parameters(
    z.object({
      expression: z.string().describe('A mathematical expression, e.g. "2 + 2"'),
    })
  )
  .context('headless')
  .authority('server')
  .server(function* ({ expression }: { expression: string }) {
    try {
      if (!/^[\d\s+\-*/().]+$/.test(expression)) {
        throw new Error('Invalid expression')
      }

      // eslint-disable-next-line no-new-func
      const result = Function(`"use strict"; return (${expression})`)()
      return { expression, result }
    } catch {
      throw new Error(`Could not evaluate: ${expression}`)
    }
  })
  .build()

export const searchIsomorphicTool = createIsomorphicTool('search')
  .description('Search for information on a topic')
  .parameters(
    z.object({
      query: z.string().describe('The search query'),
    })
  )
  .context('headless')
  .authority('server')
  .server(function* ({ query }: { query: string }) {
    yield* sleep(300)
    return {
      query,
      results: [
        {
          title: `Result 1 for "${query}"`,
          snippet: 'This is a simulated search result.',
        },
        {
          title: `Result 2 for "${query}"`,
          snippet: 'Another simulated result.',
        },
      ],
    }
  })
  .build()

export const getWeatherIsomorphicTool = createIsomorphicTool('get_weather')
  .description('Get the current weather for a location')
  .parameters(
    z.object({
      location: z.string().describe('The city name, e.g. "San Francisco"'),
      unit: z
        .enum(['celsius', 'fahrenheit'])
        .optional()
        .describe('Temperature unit'),
    })
  )
  .context('headless')
  .authority('server')
  .server(function* ({ location, unit }: { location: string; unit?: 'celsius' | 'fahrenheit' | undefined }) {
    yield* sleep(500)
    const temp = Math.floor(Math.random() * 30) + 10
    const conditions = ['sunny', 'cloudy', 'rainy', 'windy']
    const condition = conditions[Math.floor(Math.random() * conditions.length)]
    return {
      location,
      temperature: temp,
      unit: unit ?? 'celsius',
      condition,
    }
  })
  .build()
