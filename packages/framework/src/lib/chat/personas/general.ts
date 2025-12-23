import { definePersona } from './types'

export const general = definePersona({
  name: 'general',
  description: 'General purpose assistant',
  systemPrompt: 'You are a helpful assistant.',
  requiredTools: [],
  optionalTools: ['get_weather', 'search'],
  requires: {
    thinking: false,
    streaming: true,
  },
})
