/**
 * JSON Schema to TypeScript Converter
 * 
 * Lightweight converter that handles the common JSON Schema patterns
 * used in MCP tool definitions without external dependencies.
 */

type JsonSchema = Record<string, unknown>

/**
 * Convert a JSON Schema to a TypeScript type string.
 */
export function jsonSchemaToTs(schema: JsonSchema, indent = 0): string {
  
  // Handle null/undefined
  if (!schema || typeof schema !== 'object') {
    return 'unknown'
  }

  // Handle $ref (not supported - return unknown)
  if (schema['$ref']) {
    return 'unknown'
  }

  // Handle anyOf/oneOf
  if (Array.isArray(schema['anyOf'])) {
    const types = (schema['anyOf'] as JsonSchema[]).map(s => jsonSchemaToTs(s, indent))
    return types.join(' | ')
  }
  if (Array.isArray(schema['oneOf'])) {
    const types = (schema['oneOf'] as JsonSchema[]).map(s => jsonSchemaToTs(s, indent))
    return types.join(' | ')
  }

  // Handle allOf (intersection)
  if (Array.isArray(schema['allOf'])) {
    const types = (schema['allOf'] as JsonSchema[]).map(s => jsonSchemaToTs(s, indent))
    return types.join(' & ')
  }

  // Handle type
  const type = schema['type'] as string | string[] | undefined

  // Handle multiple types
  if (Array.isArray(type)) {
    const types = type.map(t => primitiveToTs(t))
    return types.join(' | ')
  }

  switch (type) {
    case 'string':
      // Handle enums
      if (Array.isArray(schema['enum'])) {
        return (schema['enum'] as string[]).map(v => JSON.stringify(v)).join(' | ')
      }
      return 'string'

    case 'number':
    case 'integer':
      if (Array.isArray(schema['enum'])) {
        return (schema['enum'] as number[]).map(v => String(v)).join(' | ')
      }
      return 'number'

    case 'boolean':
      return 'boolean'

    case 'null':
      return 'null'

    case 'array':
      const items = schema['items'] as JsonSchema | undefined
      if (items) {
        return `Array<${jsonSchemaToTs(items, indent)}>`
      }
      return 'Array<unknown>'

    case 'object':
      return objectSchemaToTs(schema, indent)

    default:
      // No type specified - check for properties
      if (schema['properties']) {
        return objectSchemaToTs(schema, indent)
      }
      return 'unknown'
  }
}

/**
 * Convert a primitive type name to TypeScript.
 */
function primitiveToTs(type: string): string {
  switch (type) {
    case 'string': return 'string'
    case 'number': return 'number'
    case 'integer': return 'number'
    case 'boolean': return 'boolean'
    case 'null': return 'null'
    case 'object': return 'Record<string, unknown>'
    case 'array': return 'Array<unknown>'
    default: return 'unknown'
  }
}

/**
 * Convert an object schema to TypeScript interface body.
 */
function objectSchemaToTs(schema: JsonSchema, indent: number): string {
  const properties = schema['properties'] as Record<string, JsonSchema> | undefined
  const required = new Set(schema['required'] as string[] ?? [])
  const additionalProperties = schema['additionalProperties']

  if (!properties || Object.keys(properties).length === 0) {
    if (additionalProperties === false) {
      return 'Record<string, never>'
    }
    if (typeof additionalProperties === 'object') {
      return `Record<string, ${jsonSchemaToTs(additionalProperties as JsonSchema, indent)}>`
    }
    return 'Record<string, unknown>'
  }

  const spaces = '  '.repeat(indent)
  const innerSpaces = '  '.repeat(indent + 1)
  
  const props = Object.entries(properties).map(([name, propSchema]) => {
    const optional = required.has(name) ? '' : '?'
    const safeName = isValidIdentifier(name) ? name : JSON.stringify(name)
    const propType = jsonSchemaToTs(propSchema, indent + 1)
    
    // Add description as comment if present
    const description = propSchema['description'] as string | undefined
    const comment = description ? `${innerSpaces}/** ${description} */\n` : ''
    
    return `${comment}${innerSpaces}${safeName}${optional}: ${propType}`
  })

  return `{\n${props.join('\n')}\n${spaces}}`
}

/**
 * Check if a string is a valid JavaScript identifier.
 */
function isValidIdentifier(name: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)
}

/**
 * Convert a name to PascalCase for interface names.
 */
export function toPascalCase(name: string): string {
  return name
    .split(/[-_\s]+/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/**
 * Convert a name to camelCase for property names.
 */
export function toCamelCase(name: string): string {
  const pascal = toPascalCase(name)
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}
