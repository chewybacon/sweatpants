import { chromium } from '@playwright/test'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

await page.goto('http://localhost:8000/chat/threaded/', { waitUntil: 'domcontentloaded' })
await page.getByText('Thread ready', { timeout: 10000 }).waitFor()
await page.getByTestId('thread-create').click()
await page.getByText('Active').waitFor()

async function pickCard(page) {
  const blocks = page.getByTestId('tool-call-block')
  const interactive = blocks.filter({ has: page.locator('button:not([disabled])').filter({ hasText: /[AKQJ\d]+[♥♦♣♠]/ }) })
  await interactive.last().waitFor({ timeout: 60000 })
  const callId = await interactive.last().getAttribute('data-call-id')
  const block = page.locator(`[data-call-id="${callId}"]`)
  const card = block.locator('button:not([disabled])').filter({ hasText: /[AKQJ\d]+[♥♦♣♠]/ }).first()
  await card.waitFor({ timeout: 60000 })
  const label = await card.textContent()
  await card.click()
  await block.getByText(`You picked: ${label?.trim()}`).waitFor({ timeout: 20000 })
  return label?.trim()
}

async function send(page, text) {
  const input = page.getByPlaceholder('Ask this thread to draw a card...')
  await input.click()
  await input.fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

await send(page, 'Draw 3 cards and let me pick one card')
const first = await pickCard(page)
console.log('First pick:', first)
await page.getByText('Thread ready', { timeout: 60000 }).waitFor()

await send(page, 'Draw another 3 cards and let me pick again')
const second = await pickCard(page)
console.log('Second pick:', second)
await page.getByText('Thread ready', { timeout: 60000 }).waitFor()

// Get threadId from the URL path
const threadId = await page.evaluate(() => {
  // Try localStorage first
  for (const key of Object.keys(localStorage)) {
    try {
      const val = JSON.parse(localStorage.getItem(key))
      if (val?.selectedThreadId) return val.selectedThreadId
    } catch {}
  }
  // Try from the active thread element
  const active = document.querySelector('[data-testid="thread-item"][aria-pressed="true"]')
  if (active) return active.getAttribute('data-thread-id')
  return null
})
console.log('Thread ID:', threadId)

// Direct fetch of the durable stream
const streamData = await page.evaluate(async (tid) => {
  const r = await fetch(`/api/chat?conversationId=${encodeURIComponent(tid)}`, {
    headers: { Accept: 'application/x-ndjson' }
  })
  return await r.text()
}, threadId)

const lines = streamData.trim().split('\n').filter(l => l.trim())
console.log(`\nDurable stream: ${lines.length} events`)
for (const line of lines) {
  try {
    const frame = JSON.parse(line)
    const event = frame.event || frame
    const type = event.type
    if (type === 'conversation_state') {
      const cs = event.conversationState || event
      const replayTraceCount = cs.replay?.toolTraces?.length || 0
      const traceCallIds = cs.replay?.toolTraces?.map(t => `${t.callId.substring(0,12)}(${t.toolName})`).join(', ') || 'none'
      console.log(`  [lsn=${frame.lsn}] conversation_state: msgs=${cs.messages?.length} toolCalls=${cs.toolCalls?.length} replay[${replayTraceCount}]: ${traceCallIds}`)
      for (const msg of (cs.messages || [])) {
        if (msg.role === 'tool') {
          const contentShort = msg.content ? msg.content.substring(0, 40) : '(empty)'
          console.log(`    tool: callId=${msg.tool_call_id?.substring(0,12)} content="${contentShort}" replay=${msg.replay ? `yes(${msg.replay.toolName})` : 'no'}`)
        }
        if (msg.role === 'assistant' && msg.tool_calls) {
          console.log(`    assistant: tool_calls=[${msg.tool_calls.map(tc => `${tc.id?.substring(0,12)}(${tc.function?.name})`).join(', ')}]`)
        }
      }
    } else if (type === 'isomorphic_handoff') {
      console.log(`  [lsn=${frame.lsn}] isomorphic_handoff: callId=${event.callId?.substring(0,12)} tool=${event.toolName}`)
    } else if (type === 'tool_result') {
      console.log(`  [lsn=${frame.lsn}] tool_result: id=${event.id?.substring(0,12)} hasTrace=${!!event.trace}`)
    } else if (type === 'complete') {
      console.log(`  [lsn=${frame.lsn}] complete`)
    } else {
      console.log(`  [lsn=${frame.lsn}] ${type}${event.content ? ': "' + event.content.substring(0, 40) + '"' : ''}`)
    }
  } catch (e) {
    console.log('  parse error')
  }
}

await browser.close()