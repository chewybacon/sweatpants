/**
 * Model Binder - Extract typed parameters from Request with precedence
 *
 * Binds request parameters from headers and query params with a defined
 * precedence order. Body is intentionally excluded due to content
 * negotiation concerns.
 *
 * Precedence: Headers > Query Params
 *
 * @example
 * ```typescript
 * const durableParams = bindModel({
 *   sessionId: stringParam('x-session-id', 'sessionId'),
 *   lastLSN: intParam('x-last-lsn', 'lastLsn'),
 * })
 *
 * const source = createBindingSource(request)
 * const params = durableParams(source)
 * // params.sessionId: string | undefined
 * // params.lastLSN: number | undefined
 * ```
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Source of binding values extracted from a Request.
 */
export interface BindingSource {
  headers: Headers
  searchParams: URLSearchParams
}

/**
 * A binder function that extracts a typed value from a BindingSource.
 */
export type Binder<T> = (source: BindingSource) => T

// =============================================================================
// PRIMITIVE BINDERS
// =============================================================================

/**
 * Create a binder for a string parameter.
 * Checks header first, then query param.
 *
 * @param headerName - HTTP header name (case-insensitive)
 * @param queryName - Query parameter name
 * @returns Binder that extracts string or undefined
 *
 * @example
 * ```typescript
 * const sessionIdBinder = stringParam('x-session-id', 'sessionId')
 * const sessionId = sessionIdBinder(source) // string | undefined
 * ```
 */
export function stringParam(
  headerName: string,
  queryName: string
): Binder<string | undefined> {
  return (source: BindingSource): string | undefined => {
    const fromHeader = source.headers.get(headerName)
    if (fromHeader !== null) {
      return fromHeader
    }

    const fromQuery = source.searchParams.get(queryName)
    if (fromQuery !== null) {
      return fromQuery
    }

    return undefined
  }
}

/**
 * Create a binder for an integer parameter.
 * Checks header first, then query param.
 * Returns undefined if value is not a valid integer.
 *
 * @param headerName - HTTP header name (case-insensitive)
 * @param queryName - Query parameter name
 * @returns Binder that extracts number or undefined
 *
 * @example
 * ```typescript
 * const lastLSNBinder = intParam('x-last-lsn', 'lastLsn')
 * const lastLSN = lastLSNBinder(source) // number | undefined
 * ```
 */
export function intParam(
  headerName: string,
  queryName: string
): Binder<number | undefined> {
  return (source: BindingSource): number | undefined => {
    const fromHeader = source.headers.get(headerName)
    if (fromHeader !== null) {
      const parsed = parseInt(fromHeader, 10)
      if (!isNaN(parsed)) {
        return parsed
      }
    }

    const fromQuery = source.searchParams.get(queryName)
    if (fromQuery !== null) {
      const parsed = parseInt(fromQuery, 10)
      if (!isNaN(parsed)) {
        return parsed
      }
    }

    return undefined
  }
}

/**
 * Create a binder for a boolean parameter.
 * Checks header first, then query param.
 * Recognizes 'true', '1', 'yes' as true; 'false', '0', 'no' as false.
 * Returns undefined for other values or if not present.
 *
 * @param headerName - HTTP header name (case-insensitive)
 * @param queryName - Query parameter name
 * @returns Binder that extracts boolean or undefined
 */
export function boolParam(
  headerName: string,
  queryName: string
): Binder<boolean | undefined> {
  const parseBoolean = (value: string): boolean | undefined => {
    const lower = value.toLowerCase()
    if (lower === 'true' || lower === '1' || lower === 'yes') {
      return true
    }
    if (lower === 'false' || lower === '0' || lower === 'no') {
      return false
    }
    return undefined
  }

  return (source: BindingSource): boolean | undefined => {
    const fromHeader = source.headers.get(headerName)
    if (fromHeader !== null) {
      const parsed = parseBoolean(fromHeader)
      if (parsed !== undefined) {
        return parsed
      }
    }

    const fromQuery = source.searchParams.get(queryName)
    if (fromQuery !== null) {
      const parsed = parseBoolean(fromQuery)
      if (parsed !== undefined) {
        return parsed
      }
    }

    return undefined
  }
}

// =============================================================================
// MODEL COMPOSITION
// =============================================================================

/**
 * Compose multiple binders into a model binder.
 * Returns a binder that produces an object with all bound values.
 *
 * @param binders - Object of named binders
 * @returns Binder that produces an object with values from each binder
 *
 * @example
 * ```typescript
 * const params = bindModel({
 *   sessionId: stringParam('x-session-id', 'sessionId'),
 *   lastLSN: intParam('x-last-lsn', 'lastLsn'),
 *   debug: boolParam('x-debug', 'debug'),
 * })
 *
 * const result = params(source)
 * // { sessionId: string | undefined, lastLSN: number | undefined, debug: boolean | undefined }
 * ```
 */
export function bindModel<T extends Record<string, Binder<unknown>>>(
  binders: T
): Binder<{ [K in keyof T]: ReturnType<T[K]> }> {
  return (source: BindingSource): { [K in keyof T]: ReturnType<T[K]> } => {
    const result = {} as { [K in keyof T]: ReturnType<T[K]> }

    for (const key of Object.keys(binders) as Array<keyof T>) {
      const binder = binders[key]!
      result[key] = binder(source) as ReturnType<T[typeof key]>
    }

    return result
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Create a BindingSource from a Request.
 *
 * @param request - The HTTP Request object
 * @returns BindingSource with headers and search params
 *
 * @example
 * ```typescript
 * const source = createBindingSource(request)
 * const params = myModelBinder(source)
 * ```
 */
export function createBindingSource(request: Request): BindingSource {
  const url = new URL(request.url)
  return {
    headers: request.headers,
    searchParams: url.searchParams,
  }
}

/**
 * Convenience function to bind a model directly from a Request.
 *
 * @param request - The HTTP Request object
 * @param binder - The model binder to use
 * @returns Bound model values
 *
 * @example
 * ```typescript
 * const params = bindFromRequest(request, durableParams)
 * ```
 */
export function bindFromRequest<T>(request: Request, binder: Binder<T>): T {
  return binder(createBindingSource(request))
}
