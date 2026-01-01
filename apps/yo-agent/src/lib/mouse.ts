/**
 * Mouse Event Handling for Terminal
 *
 * Based on Gemini CLI's mouse utilities.
 * Handles parsing of SGR and X11 mouse events from terminal stdin.
 */

// Escape sequences
export const ESC = '\u001B'
const SGR_EVENT_PREFIX = `${ESC}[<`
const X11_EVENT_PREFIX = `${ESC}[M`

// Mouse event regex patterns
const SGR_MOUSE_REGEX = /^\x1b\[<(\d+);(\d+);(\d+)([mM])/
const X11_MOUSE_REGEX = /^\x1b\[M([\s\S]{3})/

export type MouseEventName =
  | 'left-press'
  | 'left-release'
  | 'right-press'
  | 'right-release'
  | 'middle-press'
  | 'middle-release'
  | 'scroll-up'
  | 'scroll-down'
  | 'scroll-left'
  | 'scroll-right'
  | 'move'

export interface MouseEvent {
  name: MouseEventName
  col: number
  row: number
  shift: boolean
  meta: boolean
  ctrl: boolean
  button: 'left' | 'middle' | 'right' | 'none'
}

export type MouseHandler = (event: MouseEvent) => void | boolean

/**
 * Enable mouse tracking in terminal
 * ?1002h = button event tracking (clicks + drags + scroll wheel)
 * ?1006h = SGR extended mouse mode (better coordinate handling)
 */
export function enableMouseEvents() {
  process.stdout.write('\u001b[?1002h\u001b[?1006h')
}

/**
 * Disable mouse tracking in terminal
 */
export function disableMouseEvents() {
  process.stdout.write('\u001b[?1006l\u001b[?1002l')
}

function getMouseEventName(
  buttonCode: number,
  isRelease: boolean
): MouseEventName | null {
  const isMove = (buttonCode & 32) !== 0

  if (buttonCode === 66) {
    return 'scroll-left'
  } else if (buttonCode === 67) {
    return 'scroll-right'
  } else if ((buttonCode & 64) === 64) {
    if ((buttonCode & 1) === 0) {
      return 'scroll-up'
    } else {
      return 'scroll-down'
    }
  } else if (isMove) {
    return 'move'
  } else {
    const button = buttonCode & 3
    const type = isRelease ? 'release' : 'press'
    switch (button) {
      case 0:
        return `left-${type}`
      case 1:
        return `middle-${type}`
      case 2:
        return `right-${type}`
      default:
        return null
    }
  }
}

function getButtonFromCode(code: number): MouseEvent['button'] {
  const button = code & 3
  switch (button) {
    case 0:
      return 'left'
    case 1:
      return 'middle'
    case 2:
      return 'right'
    default:
      return 'none'
  }
}

function parseSGRMouseEvent(
  buffer: string
): { event: MouseEvent; length: number } | null {
  const match = buffer.match(SGR_MOUSE_REGEX)

  if (match) {
    const buttonCode = parseInt(match[1]!, 10)
    const col = parseInt(match[2]!, 10)
    const row = parseInt(match[3]!, 10)
    const action = match[4]
    const isRelease = action === 'm'

    const shift = (buttonCode & 4) !== 0
    const meta = (buttonCode & 8) !== 0
    const ctrl = (buttonCode & 16) !== 0

    const name = getMouseEventName(buttonCode, isRelease)

    if (name) {
      return {
        event: {
          name,
          ctrl,
          meta,
          shift,
          col,
          row,
          button: getButtonFromCode(buttonCode),
        },
        length: match[0].length,
      }
    }
    return null
  }

  return null
}

function parseX11MouseEvent(
  buffer: string
): { event: MouseEvent; length: number } | null {
  const match = buffer.match(X11_MOUSE_REGEX)
  if (!match) return null

  const b = match[1]!.charCodeAt(0) - 32
  const col = match[1]!.charCodeAt(1) - 32
  const row = match[1]!.charCodeAt(2) - 32

  const shift = (b & 4) !== 0
  const meta = (b & 8) !== 0
  const ctrl = (b & 16) !== 0
  const isMove = (b & 32) !== 0
  const isWheel = (b & 64) !== 0

  let name: MouseEventName | null = null

  if (isWheel) {
    const button = b & 3
    switch (button) {
      case 0:
        name = 'scroll-up'
        break
      case 1:
        name = 'scroll-down'
        break
      default:
        break
    }
  } else if (isMove) {
    name = 'move'
  } else {
    const button = b & 3
    if (button === 3) {
      name = 'left-release'
    } else {
      switch (button) {
        case 0:
          name = 'left-press'
          break
        case 1:
          name = 'middle-press'
          break
        case 2:
          name = 'right-press'
          break
        default:
          break
      }
    }
  }

  if (name) {
    let button = getButtonFromCode(b)
    if (name === 'left-release' && button === 'none') {
      button = 'left'
    }

    return {
      event: {
        name,
        ctrl,
        meta,
        shift,
        col,
        row,
        button,
      },
      length: match[0].length,
    }
  }
  return null
}

export function parseMouseEvent(
  buffer: string
): { event: MouseEvent; length: number } | null {
  return parseSGRMouseEvent(buffer) || parseX11MouseEvent(buffer)
}

function couldBeMouseSequence(buffer: string): boolean {
  if (buffer.length === 0) return true

  if (
    SGR_EVENT_PREFIX.startsWith(buffer) ||
    buffer.startsWith(SGR_EVENT_PREFIX)
  )
    return true
  if (
    X11_EVENT_PREFIX.startsWith(buffer) ||
    buffer.startsWith(X11_EVENT_PREFIX)
  )
    return true

  return false
}

export function isIncompleteMouseSequence(buffer: string): boolean {
  if (!couldBeMouseSequence(buffer)) return false

  if (parseMouseEvent(buffer)) return false

  if (buffer.startsWith(X11_EVENT_PREFIX)) {
    return buffer.length < X11_EVENT_PREFIX.length + 3
  }

  if (buffer.startsWith(SGR_EVENT_PREFIX)) {
    return !/[mM]/.test(buffer) && buffer.length < 50
  }

  return true
}
