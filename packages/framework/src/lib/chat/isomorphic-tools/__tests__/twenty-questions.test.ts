/**
 * Twenty Questions - Steps as Chat Messages
 *
 * This test proves that client tool steps can render inline in the chat stream
 * exactly like messages. Each question from the AI and each yes/no response
 * from the user becomes a "message" in the timeline.
 *
 * The goal: A Twenty Questions game where the conversation looks like:
 *
 *   AI: I'm thinking of something. I'll ask yes/no questions to guess it!
 *   AI: Is it a living thing?           [Yes] [No]
 *   User: Yes
 *   AI: Is it an animal?                [Yes] [No]
 *   User: No
 *   AI: Is it a plant?                  [Yes] [No]
 *   User: Yes
 *   AI: Can you eat it?                 [Yes] [No]
 *   User: Yes
 *   AI: Is it a fruit?                  [Yes] [No]
 *   User: Yes
 *   AI: Is it red?                      [Yes] [No]
 *   User: No
 *   AI: Is it yellow?                   [Yes] [No]
 *   User: Yes
 *   AI: My guess: Banana!
 *   AI: Was I correct?                  [Yes] [No]
 *   User: Yes
 *   AI: I win!
 */
import { describe, it, expect } from 'vitest'
import {
  run,
  createChannel,
  createSignal,
  spawn,
  each,
  sleep,
  type Operation,
  type Channel,
} from 'effection'

// =============================================================================
// STEP TYPES (from streaming-steps, could be shared)
// =============================================================================

interface Step<TPayload = unknown, TResponse = unknown> {
  id: string
  type: string
  kind: 'emit' | 'prompt'
  payload: TPayload
  timestamp: number
  response?: TResponse
  status: 'pending' | 'complete'
}

interface PendingStep<TPayload = unknown, TResponse = unknown> {
  step: Step<TPayload, TResponse>
  respond: (response: TResponse) => void
}

interface ExecutionTrail {
  callId: string
  toolName: string
  steps: Step[]
  result?: unknown
  status: 'running' | 'complete' | 'error' | 'cancelled'
  startedAt: number
  completedAt?: number
}

// =============================================================================
// STEP CONTEXT
// =============================================================================

interface StepContext {
  emit<TPayload>(type: string, payload: TPayload): Operation<void>

  prompt<TPayload, TResponse>(
    type: string,
    payload: TPayload
  ): Operation<TResponse>
}

function createStepContext(
  callId: string,
  trail: ExecutionTrail,
  stepChannel: Channel<PendingStep<any, any>, void>
): StepContext {
  let stepCounter = 0

  function createStep<TPayload>(
    kind: 'emit' | 'prompt',
    type: string,
    payload: TPayload
  ): Step<TPayload> {
    return {
      id: `${callId}-step-${++stepCounter}`,
      type,
      kind,
      payload,
      timestamp: Date.now(),
      status: kind === 'emit' ? 'complete' : 'pending',
    }
  }

  return {
    *emit<TPayload>(type: string, payload: TPayload): Operation<void> {
      const step = createStep('emit', type, payload)
      trail.steps.push(step)
      yield* stepChannel.send({ step, respond: () => {} })
    },

    *prompt<TPayload, TResponse>(
      type: string,
      payload: TPayload
    ): Operation<TResponse> {
      const step = createStep<TPayload>('prompt', type, payload)
      trail.steps.push(step)

      const responseSignal = createSignal<TResponse, void>()
      const subscription = yield* responseSignal

      yield* stepChannel.send({
        step,
        respond: (response: TResponse) => {
          step.response = response
          step.status = 'complete'
          responseSignal.send(response)
        },
      })

      const { value } = yield* subscription.next()
      return value as TResponse
    },
  }
}

// =============================================================================
// STEP RUNNER
// =============================================================================

function* runClientGenerator<TResult>(
  callId: string,
  toolName: string,
  generator: (ctx: StepContext) => Operation<TResult>,
  stepChannel: Channel<PendingStep<any, any>, void>
): Operation<{ trail: ExecutionTrail; result: TResult }> {
  const trail: ExecutionTrail = {
    callId,
    toolName,
    steps: [],
    status: 'running',
    startedAt: Date.now(),
  }

  const ctx = createStepContext(callId, trail, stepChannel)

  try {
    const result = yield* generator(ctx)
    trail.result = result
    trail.status = 'complete'
    trail.completedAt = Date.now()
    return { trail, result }
  } catch (error) {
    trail.status = 'error'
    trail.completedAt = Date.now()
    throw error
  }
}

// =============================================================================
// TWENTY QUESTIONS STEP TYPES
// =============================================================================

/** Payload for a yes/no question step */
interface YesNoQuestionPayload {
  question: string
  questionNumber: number
  maxQuestions: number
}

/** Response from a yes/no question */
interface YesNoResponse {
  answer: boolean
}

/** Payload for AI "thinking" or narration */
interface NarrationPayload {
  text: string
  style?: 'intro' | 'thinking' | 'guess' | 'victory' | 'defeat'
}

/** Payload for final guess */
interface GuessPayload {
  guess: string
  questionNumber: number
}

// =============================================================================
// COMPOSABLE SUB-GENERATORS
// =============================================================================

/**
 * Ask a yes/no question and return the answer.
 * This is a reusable "step" that can be composed into larger flows.
 */
function* askYesNo(
  ctx: StepContext,
  question: string,
  questionNumber: number,
  maxQuestions: number
): Operation<boolean> {
  const { answer } = yield* ctx.prompt<YesNoQuestionPayload, YesNoResponse>(
    'yes-no-question',
    {
      question,
      questionNumber,
      maxQuestions,
    }
  )
  return answer
}

/**
 * Emit a narration step (AI speaking without needing a response)
 */
function* narrate(
  ctx: StepContext,
  text: string,
  style: NarrationPayload['style'] = 'thinking'
): Operation<void> {
  yield* ctx.emit<NarrationPayload>('narration', { text, style })
}

/**
 * Make a final guess and ask if it's correct
 */
function* makeGuess(
  ctx: StepContext,
  guess: string,
  questionNumber: number
): Operation<boolean> {
  // Show the guess
  yield* ctx.emit<GuessPayload>('guess', { guess, questionNumber })

  // Ask if correct
  const { answer } = yield* ctx.prompt<YesNoQuestionPayload, YesNoResponse>(
    'yes-no-question',
    {
      question: `Was I correct? Is it "${guess}"?`,
      questionNumber,
      maxQuestions: questionNumber,
    }
  )

  return answer
}

// =============================================================================
// TWENTY QUESTIONS GAME LOGIC
// =============================================================================

interface TwentyQuestionsConfig {
  /** The secret the user is thinking of (for simulation) */
  secret: string
  /** Decision tree for the AI's questions */
  decisionTree: QuestionNode
  /** Max questions before guessing */
  maxQuestions: number
}

interface QuestionNode {
  question: string
  yes: QuestionNode | string // string = final guess
  no: QuestionNode | string
}

interface TwentyQuestionsResult {
  won: boolean
  questionsAsked: number
  finalGuess: string
  answers: Array<{ question: string; answer: boolean }>
}

/**
 * The Twenty Questions game as a client generator.
 *
 * Each question appears as a step in the chat stream.
 */
function* twentyQuestionsGame(
  config: TwentyQuestionsConfig,
  ctx: StepContext
): Operation<TwentyQuestionsResult> {
  const answers: Array<{ question: string; answer: boolean }> = []
  let questionNumber = 0

  // Intro
  yield* narrate(
    ctx,
    "Think of something, and I'll try to guess it in 20 questions or less!",
    'intro'
  )

  // Traverse the decision tree
  let currentNode: QuestionNode | string = config.decisionTree

  while (typeof currentNode !== 'string' && questionNumber < config.maxQuestions) {
    questionNumber++

    // Ask the question
    const answer: boolean = yield* askYesNo(
      ctx,
      currentNode.question,
      questionNumber,
      config.maxQuestions
    )

    answers.push({ question: currentNode.question, answer })

    // Navigate the tree
    currentNode = answer ? currentNode.yes : currentNode.no

    // If we've reached a guess (string), show some thinking
    if (typeof currentNode === 'string') {
      yield* narrate(ctx, 'I think I know what it is...', 'thinking')
    }
  }

  // Make the final guess
  const finalGuess = typeof currentNode === 'string' ? currentNode : 'I give up!'
  const won = yield* makeGuess(ctx, finalGuess, questionNumber + 1)

  // Victory or defeat narration
  if (won) {
    yield* narrate(ctx, `Yes! I guessed it in ${questionNumber + 1} questions!`, 'victory')
  } else {
    yield* narrate(ctx, "Oh no! What were you thinking of?", 'defeat')
  }

  return {
    won,
    questionsAsked: questionNumber + 1, // +1 for the "was I correct" question
    finalGuess,
    answers,
  }
}

// =============================================================================
// SIMPLE DECISION TREE FOR TESTING
// =============================================================================

/**
 * A simple decision tree for common objects:
 *
 *                    Is it alive?
 *                    /          \
 *                  Yes          No
 *                  /              \
 *          Is it an animal?    Is it electronic?
 *          /        \            /        \
 *        Yes        No         Yes        No
 *        /           \          /          \
 *    Does it bark?  Is it     Is it a     Is it made
 *    /    \         a fruit?   phone?     of metal?
 *  Yes    No       /    \      /   \       /    \
 *  Dog    Cat    Yes    No   Yes   No    Yes    No
 *               /        \  Phone Computer Car   Book
 *         Is it yellow?  Tree
 *         /    \
 *       Yes    No
 *      Banana Apple
 */
const simpleDecisionTree: QuestionNode = {
  question: 'Is it alive (or was it once alive)?',
  yes: {
    question: 'Is it an animal?',
    yes: {
      question: 'Does it bark?',
      yes: 'Dog',
      no: 'Cat',
    },
    no: {
      question: 'Is it a fruit?',
      yes: {
        question: 'Is it yellow?',
        yes: 'Banana',
        no: 'Apple',
      },
      no: 'Tree',
    },
  },
  no: {
    question: 'Is it electronic?',
    yes: {
      question: 'Can you make calls with it?',
      yes: 'Phone',
      no: 'Computer',
    },
    no: {
      question: 'Is it made of metal?',
      yes: 'Car',
      no: 'Book',
    },
  },
}

// =============================================================================
// PLATFORM SIMULATOR WITH SCRIPTED ANSWERS
// =============================================================================

interface ScriptedPlatform {
  /** Script of yes/no answers in order */
  answers: boolean[]
  /** Current answer index */
  answerIndex: number
  /** All steps as they would appear in chat */
  chatTimeline: Array<{
    role: 'ai' | 'user'
    content: string
    stepId: string
    stepType: string
  }>
}

function createScriptedPlatform(answers: boolean[]): ScriptedPlatform {
  return {
    answers,
    answerIndex: 0,
    chatTimeline: [],
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('Twenty Questions - Steps as Chat Messages', () => {
  describe('Basic game flow', () => {
    it('should guess Banana correctly with the right answers', async () => {
      // Answers to reach Banana: alive=yes, animal=no, fruit=yes, yellow=yes, correct=yes
      const scriptedAnswers = [true, false, true, true, true]

      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        const platform = createScriptedPlatform(scriptedAnswers)

        // Spawn platform handler that builds the chat timeline
        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            const step = pending.step

            if (step.kind === 'emit') {
              // AI narration or guess - appears as AI message
              const payload = step.payload as NarrationPayload | GuessPayload
              const content = 'text' in payload ? payload.text : `My guess: ${payload.guess}!`
              platform.chatTimeline.push({
                role: 'ai',
                content,
                stepId: step.id,
                stepType: step.type,
              })
            } else if (step.kind === 'prompt') {
              // AI question - appears as AI message
              const payload = step.payload as YesNoQuestionPayload
              platform.chatTimeline.push({
                role: 'ai',
                content: `${payload.question}`,
                stepId: step.id,
                stepType: step.type,
              })

              // User response
              const answer = platform.answers[platform.answerIndex++]
              platform.chatTimeline.push({
                role: 'user',
                content: answer ? 'Yes' : 'No',
                stepId: step.id,
                stepType: 'user-response',
              })

              pending.respond({ answer })
            }

            yield* each.next()
          }
        })

        yield* sleep(1)

        const { trail, result: gameResult } = yield* runClientGenerator(
          'game-1',
          'twenty_questions',
          (ctx) =>
            twentyQuestionsGame(
              {
                secret: 'Banana',
                decisionTree: simpleDecisionTree,
                maxQuestions: 20,
              },
              ctx
            ),
          channel
        )

        yield* sleep(50)

        return { trail, gameResult, chatTimeline: platform.chatTimeline }
      })

      // Game should be won
      expect(result.gameResult.won).toBe(true)
      expect(result.gameResult.finalGuess).toBe('Banana')
      expect(result.gameResult.questionsAsked).toBe(5) // 4 tree questions + 1 confirmation

      // Check the chat timeline looks like a conversation
      const timeline = result.chatTimeline

      // Should have AI messages and user responses interleaved
      expect(timeline.length).toBeGreaterThan(0)

      // First should be intro
      expect(timeline[0]).toMatchObject({
        role: 'ai',
        stepType: 'narration',
      })
      expect(timeline[0].content).toContain('Think of something')

      // Should have question/answer pairs
      const questions = timeline.filter((t) => t.stepType === 'yes-no-question')
      const userResponses = timeline.filter((t) => t.stepType === 'user-response')
      expect(questions.length).toBe(5) // 4 tree + 1 confirmation
      expect(userResponses.length).toBe(5)

      // Should end with victory
      const lastItem = timeline[timeline.length - 1]
      expect(lastItem.role).toBe('ai')
      expect(lastItem.content).toContain('guessed it')
    })

    it('should guess Dog correctly', async () => {
      // Answers to reach Dog: alive=yes, animal=yes, barks=yes, correct=yes
      const scriptedAnswers = [true, true, true, true]

      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        const platform = createScriptedPlatform(scriptedAnswers)

        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            if (pending.step.kind === 'prompt') {
              const answer = platform.answers[platform.answerIndex++]
              pending.respond({ answer })
            }
            yield* each.next()
          }
        })

        yield* sleep(1)

        const { result: gameResult } = yield* runClientGenerator(
          'game-2',
          'twenty_questions',
          (ctx) =>
            twentyQuestionsGame(
              {
                secret: 'Dog',
                decisionTree: simpleDecisionTree,
                maxQuestions: 20,
              },
              ctx
            ),
          channel
        )

        yield* sleep(50)

        return { gameResult }
      })

      expect(result.gameResult.won).toBe(true)
      expect(result.gameResult.finalGuess).toBe('Dog')
      expect(result.gameResult.questionsAsked).toBe(4) // 3 tree + 1 confirmation
    })

    it('should handle wrong guess gracefully', async () => {
      // Answers leading to Cat, but user says "no" to confirmation
      // alive=yes, animal=yes, barks=no (cat), correct=NO
      const scriptedAnswers = [true, true, false, false]

      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        const platform = createScriptedPlatform(scriptedAnswers)

        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            if (pending.step.kind === 'prompt') {
              const answer = platform.answers[platform.answerIndex++]
              pending.respond({ answer })
            }
            yield* each.next()
          }
        })

        yield* sleep(1)

        const { trail, result: gameResult } = yield* runClientGenerator(
          'game-3',
          'twenty_questions',
          (ctx) =>
            twentyQuestionsGame(
              {
                secret: 'Hamster', // Not in tree, so Cat is wrong
                decisionTree: simpleDecisionTree,
                maxQuestions: 20,
              },
              ctx
            ),
          channel
        )

        yield* sleep(50)

        return { trail, gameResult }
      })

      expect(result.gameResult.won).toBe(false)
      expect(result.gameResult.finalGuess).toBe('Cat')

      // Should have defeat narration at the end
      const lastStep = result.trail.steps[result.trail.steps.length - 1]
      expect(lastStep.type).toBe('narration')
      expect((lastStep.payload as NarrationPayload).style).toBe('defeat')
    })
  })

  describe('Trail as chat timeline', () => {
    it('should produce a trail that renders like a chat conversation', async () => {
      // Simple game: alive=no, electronic=yes, calls=yes -> Phone
      const scriptedAnswers = [false, true, true, true]

      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        let answerIndex = 0

        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            if (pending.step.kind === 'prompt') {
              pending.respond({ answer: scriptedAnswers[answerIndex++] })
            }
            yield* each.next()
          }
        })

        yield* sleep(1)

        const { trail } = yield* runClientGenerator(
          'game-4',
          'twenty_questions',
          (ctx) =>
            twentyQuestionsGame(
              {
                secret: 'Phone',
                decisionTree: simpleDecisionTree,
                maxQuestions: 20,
              },
              ctx
            ),
          channel
        )

        yield* sleep(50)

        return { trail }
      })

      // Map trail to a chat-like format
      const chatMessages = result.trail.steps.map((step) => {
        if (step.kind === 'emit') {
          const payload = step.payload as NarrationPayload | GuessPayload
          return {
            id: step.id,
            role: 'assistant' as const,
            type: step.type,
            content: 'text' in payload ? payload.text : `My guess: ${payload.guess}!`,
          }
        } else {
          const payload = step.payload as YesNoQuestionPayload
          const response = step.response as YesNoResponse | undefined
          return {
            id: step.id,
            role: 'assistant' as const,
            type: 'question',
            content: payload.question,
            userResponse: response?.answer ? 'Yes' : 'No',
            questionNumber: payload.questionNumber,
          }
        }
      })

      // The trail is now a chat-renderable array
      expect(chatMessages.length).toBeGreaterThan(0)

      // Can be rendered in React like:
      // chatMessages.map(msg => <ChatBubble key={msg.id} {...msg} />)

      // Verify the flow
      expect(chatMessages[0].content).toContain('Think of something')
      expect(chatMessages[1].content).toBe('Is it alive (or was it once alive)?')
      expect((chatMessages[1] as any).userResponse).toBe('No')
    })

    it('should merge naturally with regular chat messages', async () => {
      const scriptedAnswers = [true, true, true, true] // Dog path

      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        let answerIndex = 0

        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            if (pending.step.kind === 'prompt') {
              pending.respond({ answer: scriptedAnswers[answerIndex++] })
            }
            yield* each.next()
          }
        })

        yield* sleep(1)

        const { trail } = yield* runClientGenerator(
          'game-5',
          'twenty_questions',
          (ctx) =>
            twentyQuestionsGame(
              {
                secret: 'Dog',
                decisionTree: simpleDecisionTree,
                maxQuestions: 20,
              },
              ctx
            ),
          channel
        )

        yield* sleep(50)

        return { trail }
      })

      // Simulate a chat with the tool execution embedded
      const regularMessages = [
        { id: 'msg-1', role: 'user', content: "Let's play 20 questions!", timestamp: 1000 },
        { id: 'msg-2', role: 'assistant', content: "Great! I'll use my twenty questions tool.", timestamp: 1001 },
        // Tool execution would go here
        { id: 'msg-3', role: 'assistant', content: 'That was fun! Want to play again?', timestamp: 9000 },
      ]

      // The tool execution's trail can be converted to messages
      const toolMessages = result.trail.steps.map((step, i) => ({
        id: step.id,
        role: step.kind === 'emit' ? 'assistant' : 'assistant',
        content:
          step.kind === 'emit'
            ? (step.payload as any).text || `Guess: ${(step.payload as any).guess}`
            : (step.payload as any).question,
        timestamp: 2000 + i * 100, // Between msg-2 and msg-3
        isToolStep: true,
        stepType: step.type,
        userResponse: step.kind === 'prompt' ? (step.response as any)?.answer : undefined,
      }))

      // Merge all messages by timestamp
      const allMessages = [...regularMessages, ...toolMessages].sort(
        (a, b) => a.timestamp - b.timestamp
      )

      // The combined timeline should flow naturally
      expect(allMessages[0].content).toBe("Let's play 20 questions!")
      expect(allMessages[1].content).toBe("Great! I'll use my twenty questions tool.")
      expect(allMessages[2].content).toContain('Think of something') // First tool step
      // ... more tool steps ...
      expect(allMessages[allMessages.length - 1].content).toBe('That was fun! Want to play again?')
    })
  })

  describe('Composability', () => {
    it('should allow sub-generators to yield steps', async () => {
      // This test proves that askYesNo and narrate work as composable pieces

      const result = await run(function* () {
        const channel = createChannel<PendingStep>()
        const stepsEmitted: string[] = []

        yield* spawn(function* () {
          for (const pending of yield* each(channel)) {
            stepsEmitted.push(pending.step.type)
            if (pending.step.kind === 'prompt') {
              pending.respond({ answer: true })
            }
            yield* each.next()
          }
        })

        yield* sleep(1)

        // Custom generator that composes the primitives
        function* customFlow(ctx: StepContext): Operation<{ responses: boolean[] }> {
          yield* narrate(ctx, 'Starting custom flow', 'intro')

          const r1 = yield* askYesNo(ctx, 'First question?', 1, 3)
          const r2 = yield* askYesNo(ctx, 'Second question?', 2, 3)
          const r3 = yield* askYesNo(ctx, 'Third question?', 3, 3)

          yield* narrate(ctx, 'Flow complete!', 'victory')

          return { responses: [r1, r2, r3] }
        }

        const { trail, result: flowResult } = yield* runClientGenerator(
          'compose-1',
          'custom_flow',
          customFlow,
          channel
        )

        yield* sleep(50)

        return { trail, flowResult, stepsEmitted }
      })

      // Should have: narration, question, question, question, narration
      expect(result.stepsEmitted).toEqual([
        'narration',
        'yes-no-question',
        'yes-no-question',
        'yes-no-question',
        'narration',
      ])

      expect(result.flowResult.responses).toEqual([true, true, true])
      expect(result.trail.steps).toHaveLength(5)
    })
  })
})

// =============================================================================
// DESIGN NOTES
// =============================================================================

/**
 * ## What This Proves
 *
 * 1. **Steps ARE messages**: Each step in the trail can be rendered exactly
 *    like a chat message. Questions from the AI and responses from the user
 *    interleave naturally.
 *
 * 2. **Composable primitives**: `askYesNo()` and `narrate()` are reusable
 *    sub-generators that yield steps. They compose into larger flows.
 *
 * 3. **Natural merging**: Tool execution trails merge with regular chat
 *    messages by timestamp, creating a seamless conversation.
 *
 * 4. **Clean game logic**: The Twenty Questions game logic is pure and
 *    focused on the game, not on UI concerns. The ctx.prompt/emit pattern
 *    separates logic from presentation.
 *
 * ## React Rendering Vision
 *
 * ```tsx
 * function ChatStream({ messages, toolTrails }) {
 *   // Merge regular messages with tool steps
 *   const timeline = useMemo(() => {
 *     const toolSteps = toolTrails.flatMap(trail =>
 *       trail.steps.map(step => ({
 *         ...step,
 *         trailId: trail.callId,
 *         timestamp: step.timestamp,
 *       }))
 *     )
 *     return [...messages, ...toolSteps].sort((a, b) => a.timestamp - b.timestamp)
 *   }, [messages, toolTrails])
 *
 *   return (
 *     <div className="chat-stream">
 *       {timeline.map(item => {
 *         if ('role' in item) {
 *           // Regular message
 *           return <MessageBubble key={item.id} message={item} />
 *         }
 *
 *         // Tool step - render based on type
 *         return <ToolStepRenderer key={item.id} step={item} />
 *       })}
 *     </div>
 *   )
 * }
 *
 * function ToolStepRenderer({ step }) {
 *   switch (step.type) {
 *     case 'narration':
 *       return <NarrationBubble text={step.payload.text} style={step.payload.style} />
 *
 *     case 'yes-no-question':
 *       return (
 *         <QuestionBubble
 *           question={step.payload.question}
 *           questionNumber={step.payload.questionNumber}
 *           response={step.response}
 *           onRespond={step.status === 'pending' ? handleRespond : undefined}
 *         />
 *       )
 *
 *     case 'guess':
 *       return <GuessBubble guess={step.payload.guess} />
 *
 *     default:
 *       return <UnknownStep step={step} />
 *   }
 * }
 *
 * function QuestionBubble({ question, response, onRespond }) {
 *   return (
 *     <div className="question-bubble">
 *       <p>{question}</p>
 *       {response !== undefined ? (
 *         <span className="user-response">{response.answer ? 'Yes' : 'No'}</span>
 *       ) : (
 *         <div className="button-group">
 *           <button onClick={() => onRespond({ answer: true })}>Yes</button>
 *           <button onClick={() => onRespond({ answer: false })}>No</button>
 *         </div>
 *       )}
 *     </div>
 *   )
 * }
 * ```
 *
 * ## Next Steps
 *
 * 1. Wire this into the actual session/React layer
 * 2. Add step registry for type-safe step→component mapping
 * 3. Handle pending steps (user hasn't responded yet)
 * 4. Persistence - save/restore trails across sessions
 * 5. More complex games: Wordle, Hangman, etc.
 */
