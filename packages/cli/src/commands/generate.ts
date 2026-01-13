/**
 * Generate Command
 * 
 * Generates TypeScript types from an MCP server manifest.
 */

import { defineCommand } from 'citty'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fetchManifest } from '../lib/fetch-manifest.ts'
import { generateTypes } from '../lib/codegen.ts'

export const generateCommand = defineCommand({
  meta: {
    name: 'generate',
    description: 'Generate TypeScript types from an MCP server manifest',
  },
  args: {
    input: {
      type: 'string',
      description: 'URL or file path to the MCP manifest (appends /.well-known/mcp.json for URLs)',
      required: true,
      alias: 'i',
    },
    output: {
      type: 'string',
      description: 'Output file path for generated types',
      required: true,
      alias: 'o',
    },
    noHeader: {
      type: 'boolean',
      description: 'Omit the header comment in generated file',
      default: false,
    },
  },
  async run({ args }) {
    const { input, output, noHeader } = args

    console.log(`Fetching manifest from: ${input}`)
    
    try {
      // Fetch the manifest
      const manifest = await fetchManifest(input)
      
      console.log(`Found ${manifest.tools.length} tool(s):`)
      for (const tool of manifest.tools) {
        const elicitCount = Object.keys(tool._meta?.['x-sweatpants']?.elicits ?? {}).length
        console.log(`  - ${tool.name}${elicitCount > 0 ? ` (${elicitCount} elicits)` : ''}`)
      }

      // Generate types
      const code = generateTypes(manifest, {
        includeHeader: !noHeader,
        sourceUrl: input,
      })

      // Write output file
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, code, 'utf-8')

      console.log(`\nGenerated types written to: ${output}`)
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
  },
})
