/**
 * Expected Response Matchers
 *
 * Loose matchers for LLM responses that account for natural variation
 * while still catching regressions.
 *
 * These work with vitest's expect and interactors' including matcher.
 */

/**
 * A content matcher that checks if a string contains expected text.
 */
export interface ContentMatcher {
  /** Keywords that should appear in the response */
  contains?: string[]
  /** Keywords that should NOT appear in the response */
  notContains?: string[]
  /** Regex patterns that should match */
  matches?: RegExp[]
  /** Minimum content length */
  minLength?: number
  /** Maximum content length */
  maxLength?: number
}

/**
 * Check if content matches the expected patterns.
 */
export function matchesContent(content: string, matcher: ContentMatcher): boolean {
  const normalizedContent = content.toLowerCase().trim()

  // Check contains
  if (matcher.contains) {
    for (const keyword of matcher.contains) {
      if (!normalizedContent.includes(keyword.toLowerCase())) {
        return false
      }
    }
  }

  // Check notContains
  if (matcher.notContains) {
    for (const keyword of matcher.notContains) {
      if (normalizedContent.includes(keyword.toLowerCase())) {
        return false
      }
    }
  }

  // Check regex patterns
  if (matcher.matches) {
    for (const regex of matcher.matches) {
      if (!regex.test(content)) {
        return false
      }
    }
  }

  // Check length constraints
  if (matcher.minLength !== undefined && content.length < matcher.minLength) {
    return false
  }
  if (matcher.maxLength !== undefined && content.length > matcher.maxLength) {
    return false
  }

  return true
}

/**
 * Create a vitest custom matcher assertion.
 */
export function expectContentToMatch(content: string, matcher: ContentMatcher): void {
  const errors: string[] = []
  const normalizedContent = content.toLowerCase().trim()

  if (matcher.contains) {
    for (const keyword of matcher.contains) {
      if (!normalizedContent.includes(keyword.toLowerCase())) {
        errors.push(`Expected content to contain "${keyword}"`)
      }
    }
  }

  if (matcher.notContains) {
    for (const keyword of matcher.notContains) {
      if (normalizedContent.includes(keyword.toLowerCase())) {
        errors.push(`Expected content NOT to contain "${keyword}"`)
      }
    }
  }

  if (matcher.matches) {
    for (const regex of matcher.matches) {
      if (!regex.test(content)) {
        errors.push(`Expected content to match ${regex}`)
      }
    }
  }

  if (matcher.minLength !== undefined && content.length < matcher.minLength) {
    errors.push(`Expected content length >= ${matcher.minLength}, got ${content.length}`)
  }

  if (matcher.maxLength !== undefined && content.length > matcher.maxLength) {
    errors.push(`Expected content length <= ${matcher.maxLength}, got ${content.length}`)
  }

  if (errors.length > 0) {
    throw new Error(
      `Content match failed:\n${errors.join('\n')}\n\nActual content:\n"${content.slice(0, 500)}${content.length > 500 ? '...' : ''}"`
    )
  }
}

// =============================================================================
// EXPECTED MATCHERS FOR SPECIFIC PROMPTS
// =============================================================================

/**
 * Expected responses for simple prompts.
 */
export const expectedSimple = {
  whatIsTwoPlusTwo: {
    contains: ['4'],
  } satisfies ContentMatcher,

  colorOfSky: {
    contains: ['blue'],
  } satisfies ContentMatcher,

  isWaterWet: {
    matches: [/\byes\b/i],
  } satisfies ContentMatcher,

  howManyContinents: {
    contains: ['7'],
  } satisfies ContentMatcher,

  echoHello: {
    // Note: maxLength removed because LLM may include thinking content
    // which we can't control the length of
    contains: ['hello'],
  } satisfies ContentMatcher,
}

/**
 * Expected responses for markdown prompts.
 */
export const expectedMarkdown = {
  simpleList: {
    // Should have list items (rendered as <li> in HTML)
    matches: [/<li>/i],
  } satisfies ContentMatcher,

  boldText: {
    // Should have bold text (rendered as <strong> in HTML)
    matches: [/<strong>important<\/strong>/i],
  } satisfies ContentMatcher,

  codeBlock: {
    // Should have code block (rendered as <pre><code> in HTML)
    matches: [/<pre.*>.*<code/i],
  } satisfies ContentMatcher,

  heading: {
    // Should have h2 heading
    matches: [/<h2.*>.*test heading/i],
  } satisfies ContentMatcher,
}

/**
 * All expected matchers.
 */
export const expected = {
  simple: expectedSimple,
  markdown: expectedMarkdown,
} as const

export default expected
