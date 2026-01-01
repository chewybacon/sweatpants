/**
 * Mouse Provider Context
 *
 * Based on Gemini CLI's MouseContext.
 * Enables mouse event handling in terminal applications.
 * 
 * IMPORTANT: This provider intercepts Ink's internal_eventEmitter to filter
 * out mouse events and prevent them from appearing as text input.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useStdin } from 'ink'
import {
  ESC,
  enableMouseEvents,
  disableMouseEvents,
  parseMouseEvent,
  isIncompleteMouseSequence,
  type MouseEvent,
  type MouseHandler,
} from './mouse.ts'

export type { MouseEvent, MouseHandler }

const MAX_MOUSE_BUFFER_SIZE = 4096

interface MouseContextValue {
  subscribe: (handler: MouseHandler) => void
  unsubscribe: (handler: MouseHandler) => void
}

const MouseContext = createContext<MouseContextValue | undefined>(undefined)

export function useMouseContext() {
  const context = useContext(MouseContext)
  if (!context) {
    throw new Error('useMouseContext must be used within a MouseProvider')
  }
  return context
}

export function useMouse(handler: MouseHandler, { isActive = true } = {}) {
  const { subscribe, unsubscribe } = useMouseContext()

  useEffect(() => {
    if (!isActive) {
      return
    }

    subscribe(handler)
    return () => unsubscribe(handler)
  }, [isActive, handler, subscribe, unsubscribe])
}

interface MouseProviderProps {
  children: React.ReactNode
  /** Enable mouse events (default: true) */
  enabled?: boolean
}

/**
 * Strip mouse sequences from a string, returning cleaned keyboard data
 */
function stripMouseSequences(str: string): string {
  // SGR mouse events: ESC [ < Cb ; Cx ; Cy (M|m)
  const SGR_REGEX = /\x1b\[<\d+;\d+;\d+[mM]/g
  // X11 mouse events: ESC [ M Cb Cx Cy (3 bytes after M)
  const X11_REGEX = /\x1b\[M[\s\S]{3}/g
  
  let result = str.replace(SGR_REGEX, '').replace(X11_REGEX, '')
  
  // Also strip incomplete sequences at the end that look like mouse events
  // ESC [ < followed by digits/semicolons but no terminator
  result = result.replace(/\x1b\[<[\d;]*$/, '')
  // ESC [ M followed by less than 3 chars
  result = result.replace(/\x1b\[M.{0,2}$/, '')
  // Just ESC [ < or ESC [ M
  result = result.replace(/\x1b\[<$/, '').replace(/\x1b\[M$/, '')
  // Just ESC [
  result = result.replace(/\x1b\[$/, '')
  // Just ESC at the end (might be start of sequence)
  result = result.replace(/\x1b$/, '')
  
  return result
}

// Access Ink's internal event emitter type
interface InkStdinContext {
  stdin: NodeJS.ReadStream
  setRawMode: (mode: boolean) => void
  isRawModeSupported: boolean
  internal_exitOnCtrlC: boolean
  internal_eventEmitter: {
    emit: (event: string, ...args: unknown[]) => boolean
    on: (event: string, listener: (...args: unknown[]) => void) => void
    removeListener: (event: string, listener: (...args: unknown[]) => void) => void
  }
}

export function MouseProvider({
  children,
  enabled = true,
}: MouseProviderProps) {
  // Cast to access internal_eventEmitter
  const stdinContext = useStdin() as unknown as InkStdinContext
  const { internal_eventEmitter } = stdinContext
  
  const subscribers = useRef<Set<MouseHandler>>(new Set()).current
  const [isReady, setIsReady] = useState(false)
  const originalEmitRef = useRef<typeof internal_eventEmitter.emit | null>(null)

  const subscribe = useCallback(
    (handler: MouseHandler) => {
      subscribers.add(handler)
    },
    [subscribers]
  )

  const unsubscribe = useCallback(
    (handler: MouseHandler) => {
      subscribers.delete(handler)
    },
    [subscribers]
  )

  useEffect(() => {
    if (!enabled || !internal_eventEmitter) {
      setIsReady(true)
      return
    }

    // Enable mouse events in terminal
    enableMouseEvents()

    let mouseBuffer = ''

    const broadcast = (event: MouseEvent) => {
      for (const handler of subscribers) {
        if (handler(event) === true) {
          break
        }
      }
    }

    // Store original emit from internal_eventEmitter
    const originalEmit = internal_eventEmitter.emit.bind(internal_eventEmitter)
    originalEmitRef.current = originalEmit
    
    // Override emit to intercept 'input' events and filter mouse sequences
    // Ink's App component emits 'input' events on internal_eventEmitter
    internal_eventEmitter.emit = function(event: string, ...args: unknown[]): boolean {
      if (event === 'input' && args[0]) {
        const data = typeof args[0] === 'string' 
          ? args[0] 
          : String(args[0])
        
        // Add to buffer
        mouseBuffer += data
        
        // Safety cap
        if (mouseBuffer.length > MAX_MOUSE_BUFFER_SIZE) {
          mouseBuffer = mouseBuffer.slice(-MAX_MOUSE_BUFFER_SIZE)
        }

        // Process and extract mouse events
        let keyboardData = ''
        
        while (mouseBuffer.length > 0) {
          const parsed = parseMouseEvent(mouseBuffer)

          if (parsed) {
            // Found a mouse event - broadcast it and remove from buffer
            broadcast(parsed.event)
            mouseBuffer = mouseBuffer.slice(parsed.length)
            continue
          }

          if (isIncompleteMouseSequence(mouseBuffer)) {
            // Wait for more data
            break
          }

          // Check if there's an ESC that might start a mouse sequence
          const escIndex = mouseBuffer.indexOf(ESC)
          
          if (escIndex === -1) {
            // No escape sequences - all keyboard data
            keyboardData += mouseBuffer
            mouseBuffer = ''
          } else if (escIndex > 0) {
            // There's keyboard data before the escape
            keyboardData += mouseBuffer.slice(0, escIndex)
            mouseBuffer = mouseBuffer.slice(escIndex)
          } else {
            // ESC is at position 0 but not a complete mouse sequence
            // Check if it could become one
            if (mouseBuffer.length >= 2) {
              const prefix = mouseBuffer.slice(0, 3)
              if (prefix.startsWith('\x1b[<') || prefix.startsWith('\x1b[M')) {
                // This looks like the start of a mouse sequence - wait for more
                break
              }
              // Not a mouse sequence - treat ESC as keyboard data
              const nextEsc = mouseBuffer.indexOf(ESC, 1)
              if (nextEsc !== -1) {
                keyboardData += mouseBuffer.slice(0, nextEsc)
                mouseBuffer = mouseBuffer.slice(nextEsc)
              } else {
                keyboardData += mouseBuffer
                mouseBuffer = ''
              }
            } else {
              // Just ESC - wait for more data
              break
            }
          }
        }
        
        // If we have keyboard data, emit it
        if (keyboardData.length > 0) {
          // Double-check no mouse sequences slipped through
          const cleanedData = stripMouseSequences(keyboardData)
          if (cleanedData.length > 0) {
            return originalEmit('input', cleanedData)
          }
        }
        
        return false
      }
      
      // Pass through non-input events unchanged
      return originalEmit(event, ...args)
    }

    setIsReady(true)

    return () => {
      // Restore original emit
      if (originalEmitRef.current) {
        internal_eventEmitter.emit = originalEmitRef.current
      }
      disableMouseEvents()
    }
  }, [internal_eventEmitter, enabled, subscribers])

  // Don't render children until we've set up the event interception
  if (!isReady) {
    return null
  }

  return (
    <MouseContext.Provider value={{ subscribe, unsubscribe }}>
      {children}
    </MouseContext.Provider>
  )
}
