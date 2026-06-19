import { context, SpanStatusCode, trace, type Attributes, type Span, type SpanOptions } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'

const serviceName = process.env['OTEL_SERVICE_NAME']
  ?? parseResourceAttributes(process.env['OTEL_RESOURCE_ATTRIBUTES'])['service.name'] as string | undefined
  ?? 'sweatpants-agentcore-tool-session-runtime'

let sdk: NodeSDK | undefined
let started = false

function parseResourceAttributes(value: string | undefined): Record<string, string> {
  if (!value) return {}
  const attrs: Record<string, string> = {}
  for (const part of value.split(',')) {
    const [rawKey, ...rawValue] = part.split('=')
    const key = rawKey?.trim()
    if (!key) continue
    attrs[key] = rawValue.join('=').trim()
  }
  return attrs
}

export function initializeTelemetry(): void {
  if (started) return
  started = true

  if (process.env['DISABLE_ADOT_OBSERVABILITY'] === 'true') return
  if (process.env['AGENT_OBSERVABILITY_ENABLED'] === 'false') return

  // AgentCore hosted runtimes provide/expect the ADOT/OTLP environment
  // variables documented by AgentCore Observability. The default OTLP HTTP
  // exporter endpoint is intentionally left env-driven; when the AgentCore
  // ADOT pipeline is available, the standard OTEL_* variables route spans to
  // CloudWatch GenAI Observability / Transaction Search.
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env['npm_package_version'] ?? '0.1.0',
      'service.namespace': 'sweatpants',
      'deployment.environment': process.env['NODE_ENV'] ?? 'production',
      ...parseResourceAttributes(process.env['OTEL_RESOURCE_ATTRIBUTES']),
    }),
    traceExporter: new OTLPTraceExporter(),
  })

  sdk.start()
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return
  await sdk.shutdown()
}

export function tracer() {
  initializeTelemetry()
  return trace.getTracer('sweatpants-agentcore-tool-session-runtime', '0.1.0')
}

export function startSpan(name: string, attributes: Attributes = {}, options: SpanOptions = {}): Span {
  return tracer().startSpan(name, {
    ...options,
    attributes: {
      'gen_ai.system': 'aws.bedrock.agentcore',
      'agentcore.runtime.name': 'sweatpants_tool_session_tracer',
      ...attributes,
    },
  })
}

export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  const span = startSpan(name, attributes)
  try {
    return await context.with(trace.setSpan(context.active(), span), async () => {
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    })
  } catch (error) {
    span.recordException(error as Error)
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    span.end()
  }
}

export function addSpanEvent(name: string, attributes: Attributes = {}): void {
  trace.getActiveSpan()?.addEvent(name, attributes)
}

export function setSpanAttributes(attributes: Attributes): void {
  trace.getActiveSpan()?.setAttributes(attributes)
}
