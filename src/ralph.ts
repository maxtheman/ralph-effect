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
 * Orchestrator-aware: accepts optional {queue, stateRef} handles.
 * Without handles → standalone mode (original behavior).
 * With handles → drains queue between iterations, updates state ref.
 *
 * No Anthropic key needed. Just `codex login`.
 */
import { Console, Effect, Queue, SubscriptionRef, Ref } from "effect"
import { CodexLLM, CodexLLMLive } from "./codex-client.js"
import type { LoopConfig, LoopMessage, LoopState } from "./loop-types.js"
import { LoopMessage as LM } from "./loop-types.js"

// ---------------------------------------------------------------------------
// Orchestrator handles — injected by orchestrator, optional for standalone
// ---------------------------------------------------------------------------
export interface LoopHandles {
  readonly queue: Queue.Queue<LoopMessage>
  readonly stateRef: SubscriptionRef.SubscriptionRef<LoopState>
}

// ---------------------------------------------------------------------------
// The evaluation step — did the agent achieve the goal?
// Uses Codex itself as the judge (recursive, very huntley)
// ---------------------------------------------------------------------------
const evaluate = (codex: CodexLLM["Type"], goal: string, agentOutput: string) =>
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
          if (l === "DONE" || l.startsWith("DONE")) return { done: true as const, reason: "complete" }
          if (l.startsWith("FAILED")) return { done: true as const, reason: l }
          if (l.startsWith("CONTINUE:")) return { done: false as const, reason: l.replace("CONTINUE: ", "") }
        }
        // Fallback: treat as continue
        return { done: false as const, reason: text.trim().slice(0, 200) }
      }),
      Effect.catchAll((e) =>
        Effect.succeed({ done: false as const, reason: `Evaluation error: ${e.message}` })
      )
    )

// ---------------------------------------------------------------------------
// Drain messages from queue, apply to mutable refs
// ---------------------------------------------------------------------------
const drainMessages = (
  queue: Queue.Queue<LoopMessage>,
  goalRef: Ref.Ref<string>,
  maxIterRef: Ref.Ref<number>,
  pausedRef: Ref.Ref<boolean>
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
      }
    }
  })

// ---------------------------------------------------------------------------
// The Ralph loop itself — orchestrator-aware
// ---------------------------------------------------------------------------
export const ralph = (config: LoopConfig, handles?: LoopHandles) =>
  Effect.gen(function* () {
    const codex = yield* CodexLLM
    const tag = `[ralph:${config.id}]`

    // Internal mutable refs
    const goalRef = yield* Ref.make(config.goal)
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

    yield* Console.log(`\x1b[95m${tag}\x1b[0m Goal: ${config.goal}`)
    yield* Console.log(`\x1b[95m${tag}\x1b[0m Max iterations: ${config.maxIterations}`)
    yield* Console.log("")

    // Create a persistent thread for the agent work
    const agentThreadId = yield* codex.createThread()
    yield* Console.log(`\x1b[95m${tag}\x1b[0m Agent thread: ${agentThreadId}`)

    let iteration = 0

    while (true) {
      const currentMax = yield* Ref.get(maxIterRef)
      if (iteration >= currentMax) break

      // --- Drain message queue (non-blocking) ---
      yield* drainMessages(queue, goalRef, maxIterRef, pausedRef)

      // --- Check if paused ---
      const isPaused = yield* Ref.get(pausedRef)
      if (isPaused) {
        yield* Console.log(`\x1b[93m${tag}\x1b[0m Paused — waiting for resume...`)
        yield* updateState({ status: "paused" })
        // Poll queue until Resume arrives (fiber-interruptible via Effect.sleep)
        while (yield* Ref.get(pausedRef)) {
          yield* Effect.sleep("500 millis")
          yield* drainMessages(queue, goalRef, maxIterRef, pausedRef)
        }
        yield* Console.log(`\x1b[92m${tag}\x1b[0m Resumed`)
        yield* updateState({ status: "running" })
      }

      iteration++
      const currentGoal = yield* Ref.get(goalRef)
      yield* Console.log(
        `\x1b[95m${tag}\x1b[0m === Iteration ${iteration}/${yield* Ref.get(maxIterRef)} ===`
      )
      yield* updateState({ iteration, status: "running" })

      // --- Agent turn ---
      const response = yield* codex.sendTurn(agentThreadId, currentGoal).pipe(
        Effect.catchAll((e) => Effect.succeed(`Error: ${e.message}`))
      )

      if (config.verbose) {
        yield* Console.log(`\x1b[93m[agent]\x1b[0m ${response}`)
      }
      yield* updateState({ lastAgentOutput: response.slice(0, 500) })

      // --- Evaluate ---
      yield* Console.log(`\x1b[96m[eval]\x1b[0m Evaluating...`)
      const result = yield* evaluate(codex, config.goal, response)
      yield* updateState({ lastEvalResult: result.reason })

      if (result.done) {
        yield* Console.log(`\x1b[92m${tag}\x1b[0m ${result.reason}`)
        yield* updateState({ status: "done" })
        yield* codex.archiveThread(agentThreadId).pipe(Effect.catchAll(() => Effect.void))
        return { iterations: iteration, result: response }
      }

      // --- Refine ---
      yield* Console.log(`\x1b[93m${tag}\x1b[0m Continuing: ${result.reason}`)
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
const isMainModule = process.argv[1]?.includes("ralph")
  && !process.argv[1]?.includes("repl")
  && !process.argv[1]?.includes("orch")

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
