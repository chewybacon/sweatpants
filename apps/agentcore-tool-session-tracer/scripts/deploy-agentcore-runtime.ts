import crypto from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
  GetAgentRuntimeEndpointCommand,
  ListAgentRuntimesCommand,
  UpdateAgentRuntimeCommand,
  type AgentRuntime,
  type GetAgentRuntimeEndpointCommandOutput,
} from '@aws-sdk/client-bedrock-agentcore-control'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function findRuntime(client: BedrockAgentCoreControlClient, name: string): Promise<AgentRuntime | undefined> {
  let nextToken: string | undefined
  do {
    const response = await client.send(new ListAgentRuntimesCommand({ maxResults: 100, nextToken }))
    const found = response.agentRuntimes?.find((runtime) => runtime.agentRuntimeName === name)
    if (found) return found
    nextToken = response.nextToken
  } while (nextToken)
  return undefined
}

async function waitEndpoint(client: BedrockAgentCoreControlClient, runtimeId: string, endpointName = 'DEFAULT'): Promise<GetAgentRuntimeEndpointCommandOutput | undefined> {
  const timeoutMs = Number(process.env['AGENTCORE_ENDPOINT_WAIT_MS'] ?? '300000')
  const deadline = Date.now() + timeoutMs
  let last: GetAgentRuntimeEndpointCommandOutput | undefined
  while (Date.now() < deadline) {
    try {
      last = await client.send(new GetAgentRuntimeEndpointCommand({ agentRuntimeId: runtimeId, endpointName }))
      console.log(`endpoint_status=${last.status}`)
      if (last.status === 'READY') return last
      if (last.status === 'CREATE_FAILED' || last.status === 'UPDATE_FAILED') throw new Error(JSON.stringify(last, null, 2))
    } catch (error) {
      const name = (error as { name?: string }).name
      if (name !== 'ResourceNotFoundException') throw error
      console.log('endpoint_status=not-found')
    }
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  console.error('Timed out waiting for DEFAULT endpoint')
  if (last) console.error(JSON.stringify(last, null, 2))
  return last
}

async function main(): Promise<void> {
  if (process.env['APPROVE_AGENTCORE_MUTATION'] !== 'yes') {
    throw new Error('set APPROVE_AGENTCORE_MUTATION=yes after explicit approval')
  }

  const region = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1'
  const runtimeName = process.env['AGENTCORE_RUNTIME_NAME'] ?? 'sweatpants_tool_session_tracer'
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(runtimeName)) {
    throw new Error('AGENTCORE_RUNTIME_NAME must match [a-zA-Z][a-zA-Z0-9_]{0,47}')
  }

  const roleArn = requireEnv('AGENTCORE_EXECUTION_ROLE_ARN')
  const imageUri = requireEnv('IMAGE_URI')
  const client = new BedrockAgentCoreControlClient({ region })

  const environmentVariables: Record<string, string> = {}
  for (const name of [
    'AGENTCORE_OBSERVABILITY_LOG_LEVEL',
    'AGENTCORE_OBSERVABILITY_INCLUDE_PAYLOADS',
    'AGENTCORE_FASTIFY_LOG_LEVEL',
    'AGENTCORE_CLOUDWATCH_LOG_GROUP',
    'AGENTCORE_CLOUDWATCH_LOG_STREAM',
    // AgentCore / CloudWatch GenAI Observability (ADOT/OpenTelemetry)
    'AGENT_OBSERVABILITY_ENABLED',
    'DISABLE_ADOT_OBSERVABILITY',
    'OTEL_SERVICE_NAME',
    'OTEL_RESOURCE_ATTRIBUTES',
    'OTEL_EXPORTER_OTLP_PROTOCOL',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_HEADERS',
    'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
    'OTEL_TRACES_EXPORTER',
    'OTEL_METRICS_EXPORTER',
    'OTEL_LOGS_EXPORTER',
    'OTEL_SEMCONV_STABILITY_OPT_IN',
  ]) {
    const value = process.env[name]
    if (value) environmentVariables[name] = value
  }

  const common = {
    agentRuntimeArtifact: { containerConfiguration: { containerUri: imageUri } },
    roleArn,
    ...(Object.keys(environmentVariables).length > 0 ? { environmentVariables } : {}),
    networkConfiguration: { networkMode: 'PUBLIC' as const },
    protocolConfiguration: { serverProtocol: 'HTTP' as const },
    lifecycleConfiguration: {
      idleRuntimeSessionTimeout: Number(process.env['AGENTCORE_IDLE_TIMEOUT'] ?? '900'),
      maxLifetime: Number(process.env['AGENTCORE_MAX_LIFETIME'] ?? '28800'),
    },
    description: 'Sweatpants AgentCore ToolSession paused coroutine tracer',
  }

  const existing = await findRuntime(client, runtimeName)
  let runtimeId: string | undefined
  let runtimeArn: string | undefined

  if (existing?.agentRuntimeId) {
    runtimeId = existing.agentRuntimeId
    console.log(`updating_existing_runtime_id=${runtimeId}`)
    const response = await client.send(new UpdateAgentRuntimeCommand({
      agentRuntimeId: runtimeId,
      clientToken: crypto.randomUUID(),
      ...common,
    }))
    runtimeArn = response.agentRuntimeArn
  } else {
    console.log(`creating_runtime_name=${runtimeName}`)
    const response = await client.send(new CreateAgentRuntimeCommand({
      agentRuntimeName: runtimeName,
      clientToken: crypto.randomUUID(),
      ...common,
      tags: { project: 'sweatpants-agentcore-tool-session-tracer' },
    }))
    runtimeId = response.agentRuntimeId
    runtimeArn = response.agentRuntimeArn
  }

  if (!runtimeId || !runtimeArn) throw new Error('AgentCore runtime response did not include runtime id/arn')
  const endpoint = await waitEndpoint(client, runtimeId)
  const output = { agentRuntimeName: runtimeName, agentRuntimeId: runtimeId, agentRuntimeArn: runtimeArn, imageUri, endpoint }
  console.log(JSON.stringify(output, null, 2))
  await writeFile('agentcore-tool-session-tracer-deploy-output.json', JSON.stringify(output, null, 2), 'utf8')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
