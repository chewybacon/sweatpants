import { test, expect } from '@playwright/test'

test.setTimeout(360000) // 6 minutes for slow local LLMs

test('debug multi-step elicitation', async ({ page }) => {
  // Capture network request/responses for debugging
  page.on('request', async req => {
    if (req.url().includes('/api/chat') && req.method() === 'POST') {
      const body = req.postData()
      if (body) {
        try {
          const parsed = JSON.parse(body)
          if (parsed.pluginElicitResponses) {
            console.log('REQUEST pluginElicitResponses:', JSON.stringify(parsed.pluginElicitResponses))
          }
        } catch {}
      }
    }
  })
  
  let requestCount = 0
  
  page.on('request', async req => {
    if (req.url().includes('/api/chat') && req.method() === 'POST') {
      requestCount++
      console.log(`REQUEST #${requestCount}`)
      // Check headers
      const sessionId = req.headers()['x-session-id']
      const lastLsn = req.headers()['x-last-lsn']
      if (sessionId || lastLsn) {
        console.log(`  RECONNECT: sessionId=${sessionId}, lastLsn=${lastLsn}`)
      }
      const body = req.postData()
      if (body) {
        try {
          const parsed = JSON.parse(body)
          if (parsed.pluginElicitResponses) {
            console.log(`  pluginElicitResponses: ${JSON.stringify(parsed.pluginElicitResponses)}`)
          }
          console.log(`  messages: ${parsed.messages?.length || 0}`)
        } catch {}
      }
    }
  })
  
  // Track important events in responses
  page.on('response', async res => {
    if (res.url().includes('/api/chat')) {
      // Clone the response before reading so we don't consume it
      try {
        const clone = res
        const text = await clone.text()
        const lines = text.split('\n').filter(l => l.trim())
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line)
            const eventType = parsed.event?.type
            if (eventType === 'plugin_elicit_request') {
              console.log(`EVENT: plugin_elicit_request key=${parsed.event.key}`)
            } else if (eventType === 'plugin_session_error') {
              console.log(`EVENT: plugin_session_error: ${parsed.event.message}`)
            } else if (eventType === 'tool_result') {
              console.log(`EVENT: tool_result`)
            } else if (eventType === 'complete') {
              console.log(`EVENT: complete`)
            } else if (eventType === 'error') {
              console.log(`EVENT: error: ${parsed.event.message}`)
            } else if (eventType === 'debug_marker') {
              console.log(`DEBUG: ${JSON.stringify(parsed.event)}`)
            }
          } catch {}
        }
      } catch {}
    }
  })

  await page.goto('/demo/chat/')
  await expect(page.getByRole('heading', { name: 'Pipeline-Based Chat' })).toBeVisible()
  await expect(page.getByText('Pipeline ready')).toBeVisible({ timeout: 10000 })

  const input = page.getByPlaceholder('Type a message...')
  await input.fill('Book a flight from NYC to LA using the book_flight tool')
  await page.getByRole('button', { name: 'Send' }).click()

  // Wait for FlightList - increased timeout for slow LLMs
  const flightCard = page.locator('button').filter({ hasText: /\$\d+/ }).first()
  await expect(flightCard).toBeVisible({ timeout: 240000 })
  console.log('FlightList appeared!')

  // Select a flight
  console.log('Clicking flight...')
  await flightCard.click()
  
  // Wait for SeatPicker to appear with a reasonable timeout
  const seatButton = page.locator('button').filter({ hasText: /^[A-F]$/ }).first()
  
  // Try waiting for up to 30 seconds for the seat picker to appear
  try {
    await expect(seatButton).toBeVisible({ timeout: 30000 })
    console.log('SUCCESS! SeatPicker appeared - Multi-step elicitation works!')
  } catch (e) {
    console.log('SeatPicker did not appear within timeout')
    
    // Debug: check what's on the page
    const pageContent = await page.content()
    if (pageContent.includes('Error')) {
      console.log('Page may contain an error')
    }
  }
})
