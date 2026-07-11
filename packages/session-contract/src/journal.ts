import { canonicalSnapshot } from './canonical.ts'
import { CrankError, type JournalRecord, type PullDescriptor, type Result } from './types.ts'

export type IndexedPull = {
  request: Extract<JournalRecord['payload'], { type: 'pull_requested' }>
  resolution?: Extract<JournalRecord['payload'], { type: 'pull_resolved' }>
  attempts: Array<Extract<JournalRecord['payload'], { type: 'attempt_started' }>>
  abandoned: Set<string>
}

export type ReplayIndex = {
  pulls: Map<string, IndexedPull[]>
  closes: Map<string, Extract<JournalRecord['payload'], { type: 'task_closed' }>>
  taskOpens: Map<string, Extract<JournalRecord['payload'], { type: 'task_opened' }>>
  commands: Extract<JournalRecord['payload'], { type: 'command' }>['command'][]
  consumedCommands: Set<string>
}

export function validateJournal(records: readonly JournalRecord[]): void {
  const eventIds = new Set<string>()
  const tasks = new Map<string, { parent?: string; closed: boolean }>()
  const requests = new Map<string, Extract<JournalRecord['payload'], { type: 'pull_requested' }>>()
  const resolutions = new Set<string>()
  const attempts = new Map<string, { pullId: string; abandoned: boolean }>()
  const sequences = new Map<string, number>()
  const commands = new Map<string, Extract<JournalRecord['payload'], { type: 'command' }>['command']>()
  const openedChildren = new Map<string, string[]>()
  let turnCount = 0
  let sessionId: string | undefined
  let sessionClosed = false

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!
    if (record.offset !== index || eventIds.has(record.eventId)) invalid('offset/event identity')
    if (sessionId !== undefined && sessionId !== record.sessionId) invalid('mixed session ids')
    sessionId = record.sessionId
    eventIds.add(record.eventId)
    const payload = record.payload
    if (payload.type !== 'command' && record.ownerEpoch === undefined) invalid('owner epoch missing')
    if (sessionClosed) invalid('record after session close')

    switch (payload.type) {
      case 'command':
        if (commands.has(payload.command.commandId) || payload.command.sessionId !== record.sessionId) invalid('invalid command identity')
        commands.set(payload.command.commandId, payload.command)
        break
      case 'turn_opened': {
        const command = commands.get(payload.commandId)
        if (command?.type !== 'send' || payload.turnSeq !== turnCount++ || payload.turnId !== `turn-${payload.turnSeq}`) invalid('invalid turn command/sequence')
        if (tasks.has(payload.taskId) || payload.taskId !== `${payload.turnId}/root`) invalid('invalid root task')
        if (canonicalSnapshot(payload.input).sha !== payload.inputSha) invalid('turn input hash')
        tasks.set(payload.taskId, { closed: false })
        break
      }
      case 'task_opened': {
        const parentRequest = requests.get(payload.parentPullId)
        if (tasks.has(payload.taskId) || !tasks.has(payload.parentTaskId) || !parentRequest || parentRequest.taskId !== payload.parentTaskId || !['invoke', 'all'].includes(parentRequest.descriptor.kind)) invalid('invalid child opening')
        if (canonicalSnapshot(payload.input).sha !== payload.inputSha) invalid('child input hash')
        tasks.set(payload.taskId, { parent: payload.parentTaskId, closed: false })
        openedChildren.set(payload.parentPullId, [...(openedChildren.get(payload.parentPullId) ?? []), payload.taskId])
        break
      }
      case 'pull_requested': {
        if (!tasks.has(payload.taskId) || tasks.get(payload.taskId)!.closed || requests.has(payload.pullId)) invalid('invalid pull request')
        const taskPulls = [...requests.values()].filter((request) => request.taskId === payload.taskId)
        if (payload.pullIndex !== taskPulls.length) invalid('non-contiguous pull index')
        if (descriptorFingerprint(payload.descriptor) !== payload.inputSha) invalid('pull input hash')
        requests.set(payload.pullId, payload)
        break
      }
      case 'pull_resolved': {
        const request = requests.get(payload.pullId)
        if (!request || resolutions.has(payload.pullId)) invalid('invalid pull resolution')
        if (payload.commandId) {
          const command = commands.get(payload.commandId)
          if (command?.type !== 'respond' || command.pullId !== payload.pullId || request.descriptor.kind !== 'elicit') invalid('invalid response command reference')
        }
        if ((request.descriptor.kind === 'invoke' || request.descriptor.kind === 'all') &&
          (openedChildren.get(payload.pullId) ?? []).some((taskId) => !tasks.get(taskId)?.closed)) invalid('parent resolved before child close')
        resolutions.add(payload.pullId)
        break
      }
      case 'attempt_started':
        if (!requests.has(payload.pullId) || attempts.has(payload.attemptId)) invalid('invalid attempt start')
        if (payload.attemptIndex !== [...attempts.values()].filter((attempt) => attempt.pullId === payload.pullId).length) invalid('attempt index')
        attempts.set(payload.attemptId, { pullId: payload.pullId, abandoned: false })
        break
      case 'attempt_abandoned': {
        const attempt = attempts.get(payload.attemptId)
        if (!attempt || attempt.pullId !== payload.pullId || attempt.abandoned || resolutions.has(payload.pullId)) invalid('invalid abandonment')
        attempt.abandoned = true
        break
      }
      case 'durable_emission': {
        const attempt = attempts.get(payload.attemptId)
        if (!attempt || attempt.pullId !== payload.pullId || attempt.abandoned) invalid('invalid emission attempt')
        const expected = sequences.get(payload.attemptId) ?? 0
        if (payload.sequence !== expected) invalid('emission sequence')
        sequences.set(payload.attemptId, expected + 1)
        break
      }
      case 'task_closed': {
        const task = tasks.get(payload.taskId)
        if (payload.commandId) {
          const command = commands.get(payload.commandId)
          if (command?.type !== 'cancel_turn' || command.turnId !== payload.turnId || payload.result.status !== 'cancelled') invalid('invalid cancellation command reference')
        }
        if (!task || task.closed) invalid('duplicate/unknown task close')
        if ([...tasks.values()].some((candidate) => candidate.parent === payload.taskId && !candidate.closed)) invalid('parent closed before child')
        task.closed = true
        break
      }
      case 'session_closed':
        if (commands.get(payload.commandId)?.type !== 'close_session') invalid('invalid close command reference')
        sessionClosed = true
        break
      default:
        invalid('unknown event family')
    }
  }
}

export function buildReplayIndex(records: readonly JournalRecord[], turnId?: string): ReplayIndex {
  validateJournal(records)
  const pulls = new Map<string, IndexedPull[]>()
  const closes = new Map<string, Extract<JournalRecord['payload'], { type: 'task_closed' }>>()
  const taskOpens = new Map<string, Extract<JournalRecord['payload'], { type: 'task_opened' }>>()
  const commands: ReplayIndex['commands'] = []
  const consumedCommands = new Set<string>()
  const byPullId = new Map<string, IndexedPull>()

  for (const record of records) {
    const payload = record.payload
    if (payload.type === 'command') commands.push(payload.command)
    if ('turnId' in payload && turnId !== undefined && payload.turnId !== turnId) continue
    switch (payload.type) {
      case 'pull_requested': {
        const indexed: IndexedPull = { request: payload, attempts: [], abandoned: new Set() }
        const list = pulls.get(payload.taskId) ?? []
        list.push(indexed)
        pulls.set(payload.taskId, list)
        byPullId.set(payload.pullId, indexed)
        break
      }
      case 'pull_resolved':
        byPullId.get(payload.pullId)!.resolution = payload
        if (payload.commandId) consumedCommands.add(payload.commandId)
        break
      case 'attempt_started':
        byPullId.get(payload.pullId)!.attempts.push(payload)
        break
      case 'attempt_abandoned':
        byPullId.get(payload.pullId)!.abandoned.add(payload.attemptId)
        break
      case 'task_opened':
        taskOpens.set(payload.taskId, payload)
        break
      case 'task_closed':
        closes.set(payload.taskId, payload)
        if (payload.commandId) consumedCommands.add(payload.commandId)
        break
      case 'turn_opened':
      case 'session_closed':
      case 'durable_emission':
      case 'command':
        break
    }
    if (payload.type === 'turn_opened' || payload.type === 'session_closed') consumedCommands.add(payload.commandId)
  }
  return { pulls, closes, taskOpens, commands, consumedCommands }
}

export function descriptorFingerprint(descriptor: PullDescriptor): string {
  switch (descriptor.kind) {
    case 'effect':
    case 'elicit':
    case 'record':
    case 'invoke':
      return canonicalSnapshot(descriptor.input).sha
    case 'all':
      return canonicalSnapshot(descriptor.children as unknown).sha
    case 'emit':
      return canonicalSnapshot(descriptor.payload).sha
  }
}

export function descriptorIdentity(descriptor: PullDescriptor): string {
  switch (descriptor.kind) {
    case 'effect':
    case 'elicit':
    case 'record': return descriptor.effectId
    case 'invoke': return descriptor.programId
    case 'all': return descriptor.children.map((child) => child.programId).join(',')
    case 'emit': return descriptor.eventType
  }
}

export function resultEquals(left: Result, right: Result): boolean {
  return canonicalSnapshot(left as unknown).canonical === canonicalSnapshot(right as unknown).canonical
}

function invalid(message: string): never {
  throw new CrankError('invalid_journal', message)
}
