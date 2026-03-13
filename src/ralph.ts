/**
 * ralph.ts — The Ralph Wiggum Loop backed by Codex.
 *
 * The huntley pattern:
 *   1. Give the agent a goal
 *   2. Agent runs autonomously (Codex handles tool loop)
 *   3. Evaluate: is the goal met? (uses Codex as the judge)
 *   4. If not: feed errors/output back, refine, loop
 *   5. Watch the inferencing — you're on the loop, not in the loop
 *
 * Orchestrator-aware: accepts optional {queue, stateRef, eventBus} handles.
 * Without handles → standalone mode (original behavior).
 * With handles → drains queue between iterations, updates state ref.
 *
 * Phase 1: Separated context model.
 *   - goalRef: clean goal string (never polluted by injected context)
 *   - contextRef: sliding window of ContextItem objects
 *   - Agent turns compose multi-item input: [goal, ...contextItems]
 *   - Evaluator sees ONLY the goal — never injected context
 *   - Custom evaluators override default LLM-as-judge
 *
 * No Anthropic key needed. Just `codex login`.
 */
import { Console, Effect, Queue, SubscriptionRef, PubSub, Ref } from "effect"
import { CodexLLM, CodexLLMLive } from "./codex-client.js"
import type {
  LoopConfig,
  LoopMessage,
  LoopState,
  LoopEvent,
  ContextItem,
  EvalResult
} from "./loop-types.js"
import { LoopMessage as LM, LoopEvent as LE } from "./loop-types.js"

// ---------------------------------------------------------------------------
// Orchestrator handles — injected by orchestrator, optional for standalone
// ---------------------------------------------------------------------------
export interface LoopHandles {
  readonly queue: Queue.Queue<LoopMessage>
  readonly stateRef: SubscriptionRef.SubscriptionRef<LoopState>
  readonly eventBus: PubSub.PubSub<LoopEvent>
}

// ---------------------------------------------------------------------------
// The evaluation step — did the agent achieve the goal?
// Uses Codex itself as the judge (recursive, very huntley)
// ---------------------------------------------------------------------------
const defaultEvaluate = (
  codex: CodexLLM["Type"],
  goal: string,
  agentOutput: string
): Effect.Effect<EvalResult, Error> =>
  codex
    .generateText(
      `You are a strict evaluator. Based ONLY on the agent output below, decide if the goal was met.

GOAL: ${goal}

AGENT OUTPUT:
${agentOutput}

Do NOT run any tools or verify anything yourself. Just read the output above.
Your ENTIRE response must be exactly one line — one of:
DONE
CONTINUE: <what still needs to be done>
FAILED: <reason>`
    )
    .pipe(
      Effect.map((text) => {
        // Check all lines for verdict — Codex may prepend reasoning
        const lines = text.trim().split("\n")
        for (const line of lines) {
          const l = line.trim()
          if (l === "DONE" || l.startsWith("DONE")) return { done: true, reason: "complete" }
          if (l.startsWith("FAILED")) return { done: false, reason: l }
          if (l.startsWith("CONTINUE:")) return { done: false, reason: l.replace("CONTINUE: ", "") }
        }
        // Fallback: treat as continue
        return { done: false, reason: text.trim().slice(0, 200) }
      }),
      Effect.catchAll((e) =>
        Effect.succeed({ done: false, reason: `Evaluation error: ${e.message}` })
      )
    )

// ---------------------------------------------------------------------------
// Drain messages from queue, apply to mutable refs
// Phase 1: InjectContext populates contextRef (NOT goalRef)
// ---------------------------------------------------------------------------
const drainMessages = (
  queue: Queue.Queue<LoopMessage>,
  goalRef: Ref.Ref<string>,
  maxIterRef: Ref.Ref<number>,
  pausedRef: Ref.Ref<boolean>,
  contextRef: Ref.Ref<ReadonlyArray<ContextItem>>,
  maxContextItems: number
) =>
  Effect.gen(function* () {
    const messages = yield* Queue.takeAll(queue)
    for (const msg of messages) {
      switch (msg._tag) {
        case "UserMessage":
          yield* Ref.update(goalRef, (g) => `${g}\n\nAdditional user instruction: ${msg.text}`)
          break
        case "SetGoal":
          yield* Ref.set(goalRef, msg.goal)
          break
        case "Pause":
          yield* Ref.set(pausedRef, true)
          break
        case "Resume":
          yield* Ref.set(pausedRef, false)
          break
        case "SetMaxIterations":
          yield* Ref.set(maxIterRef, msg.max)
          break
        case "InjectContext":
          // Phase 1: populate contextRef with sliding window
          yield* Ref.update(contextRef, (items) => {
            const next = [...items, msg.item]
            return next.length > maxContextItems ? next.slice(-maxContextItems) : next
          })
          break
        case "ClearContext":
          yield* Ref.set(contextRef, [])
          break
      }
    }
  })

// ---------------------------------------------------------------------------
// Compose multi-item input for a turn: goal + context items
// ---------------------------------------------------------------------------
const composeInput = (
  goal: string,
  context: ReadonlyArray<ContextItem>
): ReadonlyArray<{ type: "text"; text: string }> => {
  const items: Array<{ type: "text"; text: string }> = [
    { type: "text", text: goal }
  ]
  for (const ctx of context) {
    const label = ctx.tag ? ` (${ctx.tag})` : ""
    items.push({
      type: "text",
      text: `[Context from ${ctx.source}${label}]: ${ctx.text}`
    })
  }
  return items
}

// ---------------------------------------------------------------------------
// The Ralph loop itself — orchestrator-aware
// ---------------------------------------------------------------------------
export const ralph = (config: LoopConfig, handles?: LoopHandles) =>
  Effect.gen(function* () {
    const codex = yield* CodexLLM
    const tag = `[ralph:${config.id}]`
    const maxCtx = config.maxContextItems ?? 5

    // Internal mutable refs — goal and context are SEPARATE
    const goalRef = yield* Ref.make(config.goal)
    const contextRef = yield* Ref.make<ReadonlyArray<ContextItem>>([])
    const maxIterRef = yield* Ref.make(config.maxIterations)
    const pausedRef = yield* Ref.make(false)

    // If no handles provided (standalone mode), create a dummy queue
    const queue = handles?.queue ?? (yield* Queue.unbounded<LoopMessage>())

    // Helper to update orchestrator state ref (no-op in standalone)
    const updateState = (patch: Partial<LoopState>) =>
      handles?.stateRef
        ? SubscriptionRef.update(handles.stateRef, (s) => ({
            ...s,
            ...patch,
            updatedAt: Date.now()
          }))
        : Effect.void

    // Helper to publish lifecycle events (no-op in standalone)
    const publishEvent = (event: LoopEvent) =>
      handles?.eventBus
        ? PubSub.publish(handles.eventBus, event)
        : Effect.void

    // Resolve evaluator: custom or default LLM-as-judge
    const evaluate = config.evaluator
      ? config.evaluator
      : (goal: string, output: string) => defaultEvaluate(codex, goal, output)

    yield* Console.log(`\x1b[95m${tag}\x1b[0m Goal: ${config.goal}`)
    yield* Console.log(`\x1b[95m${tag}\x1b[0m Max iterations: ${config.maxIterations}`)
    if (config.agent?.personality) {
      yield* Console.log(`\x1b[95m${tag}\x1b[0m Personality: ${config.agent.personality.slice(0, 60)}...`)
    }
    yield* Console.log("")

    // Create a persistent thread for the agent work (with agent config)
    const agentThreadId = yield* codex.createThread(config.agent)
    yield* Console.log(`\x1b[95m${tag}\x1b[0m Agent thread: ${agentThreadId}`)
    yield* updateState({ threadId: agentThreadId })

    let iteration = 0

    while (true) {
      const currentMax = yield* Ref.get(maxIterRef)
      if (iteration >= currentMax) break

      // --- Drain message queue (non-blocking) ---
      yield* drainMessages(queue, goalRef, maxIterRef, pausedRef, contextRef, maxCtx)

      // --- Check if paused ---
      const isPaused = yield* Ref.get(pausedRef)
      if (isPaused) {
        yield* Console.log(`\x1b[93m${tag}\x1b[0m Paused — waiting for resume...`)
        yield* updateState({ status: "paused" })
        // Poll queue until Resume arrives (fiber-interruptible via Effect.sleep)
        while (yield* Ref.get(pausedRef)) {
          yield* Effect.sleep("500 millis")
          yield* drainMessages(queue, goalRef, maxIterRef, pausedRef, contextRef, maxCtx)
        }
        yield* Console.log(`\x1b[92m${tag}\x1b[0m Resumed`)
        yield* updateState({ status: "running" })
      }

      iteration++
      const currentGoal = yield* Ref.get(goalRef)
      const currentContext = yield* Ref.get(contextRef)
      yield* Console.log(
        `\x1b[95m${tag}\x1b[0m === Iteration ${iteration}/${yield* Ref.get(maxIterRef)} ===`
      )
      if (currentContext.length > 0) {
        yield* Console.log(
          `\x1b[90m${tag}\x1b[0m  Context items: ${currentContext.length} (from: ${currentContext.map((c) => c.source).join(", ")})`
        )
        // Show full context content so you can track what's being passed between agents
        for (const ctx of currentContext) {
          const label = ctx.tag ? ` [${ctx.tag}]` : ""
          yield* Console.log(
            `\x1b[90m${tag}  ── context from ${ctx.source}${label} ──\x1b[0m\n${ctx.text}\n\x1b[90m${tag}  ── end context ──\x1b[0m`
          )
        }
      }
      yield* updateState({ iteration, status: "running", goal: currentGoal, context: currentContext })

      // --- Agent turn: compose multi-item input (goal + context as separate items) ---
      const input = composeInput(currentGoal, currentContext)
      const response = yield* codex.sendTurn(agentThreadId, input).pipe(
        Effect.catchAll((e) => Effect.succeed(`Error: ${e.message}`))
      )

      // Always show the full agent response (was previously gated on verbose)
      yield* Console.log(
        `\n\x1b[93m${tag} ── agent response ──\x1b[0m\n${response}\n\x1b[93m${tag} ── end response ──\x1b[0m`
      )
      yield* updateState({ lastAgentOutput: response })

      // --- Clear context after use (it was delivered to the agent this turn) ---
      yield* Ref.set(contextRef, [])
      yield* updateState({ context: [] })

      // --- Evaluate (uses currentGoal ONLY — evaluator never sees injected context) ---
      yield* Console.log(`\x1b[96m${tag} [eval]\x1b[0m Evaluating iteration ${iteration}...`)
      const result = yield* evaluate(currentGoal, response)
      yield* Console.log(
        result.done
          ? `\x1b[92m${tag} [eval] ✓ DONE\x1b[0m ${result.reason}`
          : `\x1b[93m${tag} [eval] → CONTINUE\x1b[0m ${result.reason}`
      )
      yield* updateState({ lastEvalResult: result.reason })

      // --- Publish IterationComplete event ---
      yield* publishEvent(
        LE.IterationComplete({
          id: config.id,
          iteration,
          evalResult: result.reason
        })
      )

      if (result.done) {
        yield* Console.log(`\x1b[92m${tag}\x1b[0m Completed after ${iteration} iteration(s)`)
        yield* updateState({ status: "done" })
        yield* codex.archiveThread(agentThreadId).pipe(Effect.catchAll(() => Effect.void))
        return { iterations: iteration, result: response }
      }

      // --- Refine ---
      yield* Console.log(`\x1b[93m${tag}\x1b[0m Refining goal for next iteration...`)
      yield* Ref.set(goalRef, [
        `Original goal: ${config.goal}`,
        `\nPrevious attempt output:\n${response}`,
        `\nWhat still needs to be done: ${result.reason}`,
        `\nPlease continue working on the original goal.`
      ].join("\n"))
    }

    yield* Console.log(`\x1b[91m${tag}\x1b[0m Hit max iterations (${yield* Ref.get(maxIterRef)})`)
    yield* updateState({ status: "done" })
    yield* codex.archiveThread(agentThreadId).pipe(Effect.catchAll(() => Effect.void))
    return { iterations: iteration, result: "max iterations reached" }
  })

// ---------------------------------------------------------------------------
// CLI entry point (standalone mode) — only runs when this file is the entry
// ---------------------------------------------------------------------------
// Check if THIS file is the entry point (not just a directory containing "ralph")
const entryFile = process.argv[1]?.split("/").pop() ?? ""
const isMainModule = (entryFile === "ralph.ts" || entryFile === "ralph.js")

if (isMainModule) {
  const goal = process.argv[2]

  if (!goal) {
    console.log("Usage: npx tsx src/ralph.ts <goal>")
    console.log('Example: npx tsx src/ralph.ts "create a fizzbuzz.js file and verify it works"')
    process.exit(1)
  }

  const main = ralph({
    id: "cli",
    goal,
    maxIterations: parseInt(process.argv[3] || "10", 10),
    verbose: process.argv.includes("--verbose")
  }).pipe(
    Effect.provide(CodexLLMLive),
    Effect.catchAll((e) => Console.log(`Ralph failed: ${e}`))
  )

  Effect.runPromise(main)
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}
