import { getElicitContext, makePlugin, stripMessageContext } from '@sweatpants/framework/chat'

import { CardPicker } from './components/CardPicker'
import { pickCard } from './tool'

type PickCardContext = {
  cards: Array<{ rank: string; suit: string; display: string }>
  prompt: string
  [key: string]: unknown
}

function* replayPickCardTrace(trace: {
  emissions: Array<{
    order: number
    componentKey: string
    props: Record<string, unknown>
    response?: unknown
    timestamp: number
  }>
  startedAt: number
  completedAt: number
}) {
  return {
    ...trace,
    emissions: trace.emissions.map((entry) => ({
      ...entry,
      _component: CardPicker,
    })),
  }
}

export const pickCardPlugin = makePlugin(pickCard)
  .onElicit({
    pickCard: function* (req, ctx) {
      const context = getElicitContext<PickCardContext>(req)
      const cards = context.cards ?? []
      const prompt = context.prompt ?? stripMessageContext(req.message)
      const result = yield* ctx.render(CardPicker, { cards, prompt })
      return { action: 'accept' as const, content: result }
    },
  })
  .build()

;(pickCard as typeof pickCard & { replayTrace?: typeof replayPickCardTrace }).replayTrace = replayPickCardTrace
