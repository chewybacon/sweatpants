#!/usr/bin/env node
/**
 * yo-agent CLI
 *
 * A terminal-based AI coding assistant built on the framework.
 * Runs inside an Effection main() for structured concurrency.
 *
 * Architecture:
 * - Effection main loop manages Vite dev server + Ink TUI
 * - Vite provides HMR for tools
 * - React/Ink provides the UI
 * - Dev server bridges them together
 */
import React, { useState, useEffect } from 'react'
import { render } from 'ink'
import { main, spawn, each, call, suspend } from 'effection'
import { App } from './components/App.tsx'
import { AgentProvider, type AgentContextValue } from './lib/agent-context.tsx'
import { MouseProvider } from './lib/MouseProvider.tsx'
import { useDevServer, type DevServerHandle } from './lib/dev-server.ts'
import type { AgentMode } from './components/App.tsx'

/**
 * Bridge component that syncs Effection state to React
 */
function AgentApp({ 
  devServer, 
  onHmrEvent 
}: { 
  devServer: DevServerHandle | null
  onHmrEvent: (event: { type: string; file: string; timestamp: number }) => void
}) {
  const [mode, setMode] = useState<AgentMode>('plan')
  const [lastHmrEvent, setLastHmrEvent] = useState<AgentContextValue['lastHmrEvent']>(null)

  // Subscribe to HMR events from dev server
  useEffect(() => {
    if (!devServer) return

    // We can't use Effection directly in useEffect, so we poll the signal
    // In a real implementation, we'd use a more sophisticated bridge
    const checkEvents = async () => {
      // This is a placeholder - the actual HMR events come through Effection
      // We'll handle this via the onHmrEvent callback from the main loop
    }
    
    checkEvents()
  }, [devServer])

  // Handle HMR events passed from main loop
  useEffect(() => {
    if (lastHmrEvent) {
      // Clear after 3 seconds
      const timer = setTimeout(() => setLastHmrEvent(null), 3000)
      return () => clearTimeout(timer)
    }
  }, [lastHmrEvent])

  const contextValue: AgentContextValue = {
    devServer,
    mode,
    isReady: devServer !== null,
    lastHmrEvent,
  }

  return (
    <MouseProvider enabled={true}>
      <AgentProvider value={contextValue}>
        <App />
      </AgentProvider>
    </MouseProvider>
  )
}

await main(function* () {
  // Check if we're in an interactive terminal
  const isInteractive = process.stdin.isTTY

  if (!isInteractive) {
    console.error('yo-agent requires an interactive terminal.')
    console.error('Please run from a terminal that supports TTY.')
    return
  }

  console.log('Starting yo-agent...')
  console.log('Initializing Vite dev server for HMR...')

  // Start the dev server (Vite + handler)
  const devServer = yield* useDevServer({
    root: process.cwd(),
    toolsPath: './src/tools',
    provider: 'ollama',
  })

  console.log('Dev server ready!')
  console.log('Tools will hot-reload on file changes.\n')

  // Track for passing to React
  let hmrCallback: ((event: { type: string; file: string; timestamp: number }) => void) | null = null

  // Watch for HMR events and log them
  yield* spawn(function* () {
    for (const event of yield* each(devServer.reloadEvents)) {
      console.log(`[HMR] Reloaded: ${event.type} - ${event.file}`)
      
      // Notify React if callback is set
      if (hmrCallback) {
        hmrCallback({ ...event, timestamp: Date.now() })
      }
      
      yield* each.next()
    }
  })

  // Render the Ink app
  const instance = render(
    <AgentApp 
      devServer={devServer} 
      onHmrEvent={(event) => {
        // Store for later - React will pick it up
        hmrCallback = () => {}
      }}
    />
  )

  // Store the callback setter
  hmrCallback = (event) => {
    // This is tricky - we need to trigger a React re-render
    // For now, we just log. Full integration would need a signal/channel bridge
    console.log(`[HMR] UI notified: ${event.file}`)
  }

  try {
    // Wait for the app to exit
    // Using call() to properly convert Promise to Operation
    yield* call(() => instance.waitUntilExit())
  } finally {
    instance.unmount()
  }
})
