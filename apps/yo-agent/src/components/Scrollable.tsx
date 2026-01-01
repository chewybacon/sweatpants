/**
 * Scrollable Component
 *
 * A scroll container with mouse wheel support.
 * Uses @jrichman/ink fork's built-in overflow: scroll support.
 *
 * Key features:
 * - Auto-scroll to bottom when new children are added (if scrollToBottom=true)
 * - Mouse wheel scrolling support
 * - Works with dynamic content (streaming messages)
 */
import React, { useState, useRef, useLayoutEffect, useCallback } from 'react'
import { Box, getInnerHeight, getScrollHeight, type DOMElement } from 'ink'
import { useMouse, type MouseEvent } from '../lib/MouseProvider.tsx'

interface ScrollableProps {
  children?: React.ReactNode
  /** Height of the scrollable area */
  height?: number | string
  /** Whether to auto-scroll to bottom when children change */
  scrollToBottom?: boolean
  /** Flex grow factor */
  flexGrow?: number
  /** Scrollbar thumb color */
  scrollbarThumbColor?: string
  /** Scroll speed multiplier for mouse wheel */
  scrollSpeed?: number
}

export function Scrollable({
  children,
  height,
  scrollToBottom = true,
  flexGrow,
  scrollbarThumbColor = 'gray',
  scrollSpeed = 3,
}: ScrollableProps) {
  const [scrollTop, setScrollTop] = useState(0)
  const ref = useRef<DOMElement>(null)
  const [size, setSize] = useState({
    innerHeight: 0,
    scrollHeight: 0,
  })
  const sizeRef = useRef(size)

  useLayoutEffect(() => {
    sizeRef.current = size
  }, [size])

  const childrenCountRef = useRef(0)
  // Track if user has manually scrolled up (breaks auto-scroll-to-bottom)
  const isStickingToBottom = useRef(true)

  // This effect runs on every render to correctly measure the container
  // and scroll to the bottom if new children are added.
  useLayoutEffect(() => {
    if (!ref.current) {
      return
    }

    const innerHeight = Math.round(getInnerHeight(ref.current))
    const scrollHeight = Math.round(getScrollHeight(ref.current))

    const isAtBottom = scrollTop >= size.scrollHeight - size.innerHeight - 1

    if (
      size.innerHeight !== innerHeight ||
      size.scrollHeight !== scrollHeight
    ) {
      setSize({ innerHeight, scrollHeight })
      // If we were at the bottom, stay at the bottom
      if (isAtBottom || isStickingToBottom.current) {
        setScrollTop(Math.max(0, scrollHeight - innerHeight))
      }
    }

    const childCountCurrent = React.Children.count(children)
    if (scrollToBottom && childrenCountRef.current !== childCountCurrent) {
      // New children added - scroll to bottom if we're sticking
      if (isStickingToBottom.current) {
        setScrollTop(Math.max(0, scrollHeight - innerHeight))
      }
    }
    childrenCountRef.current = childCountCurrent
  })

  const scrollBy = useCallback(
    (delta: number) => {
      const { scrollHeight, innerHeight } = sizeRef.current
      setScrollTop((current) => {
        const newScrollTop = Math.min(
          Math.max(0, current + delta),
          Math.max(0, scrollHeight - innerHeight)
        )
        
        // Update sticking state based on scroll direction
        if (delta < 0) {
          // Scrolling up - user is reading history
          isStickingToBottom.current = false
        } else {
          // Scrolling down - check if we're at bottom
          const maxScroll = scrollHeight - innerHeight
          if (newScrollTop >= maxScroll - 1) {
            isStickingToBottom.current = true
          }
        }
        
        return newScrollTop
      })
    },
    []
  )

  // Handle mouse wheel events
  const handleMouse = useCallback(
    (event: MouseEvent): boolean | void => {
      if (event.name === 'scroll-up') {
        scrollBy(-scrollSpeed)
        return true // Consume the event
      } else if (event.name === 'scroll-down') {
        scrollBy(scrollSpeed)
        return true
      }
    },
    [scrollBy, scrollSpeed]
  )

  useMouse(handleMouse, { isActive: true })

  return (
    <Box
      ref={ref}
      height={height}
      flexDirection="column"
      overflowY="scroll"
      scrollTop={scrollTop}
      flexGrow={flexGrow}
      scrollbarThumbColor={scrollbarThumbColor}
    >
      {/*
        Inner box prevents parent from shrinking based on children's content.
        Adds right padding to make room for the scrollbar.
      */}
      <Box flexShrink={0} paddingRight={1} flexDirection="column">
        {children}
      </Box>
    </Box>
  )
}
