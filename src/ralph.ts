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
 * No Anthropic key needed. Just `codex login`.
 */
import { Console, Effect } from "effect"
import { CodexLLM, CodexLLMLive } from "./codex-client.js"

// ---------------------------------------------------------------------------
// Ralph loop configuration
// ---------------------------------------------------------------------------
interface RalphConfig {
  readonly goal: string
  readonly maxIterations: number
  readonly verbose: boolean
}

// ---------------------------------------------------------------------------
// The evaluation step — did the agent achieve the goal?
// Uses Codex itself as the judge (recursive, very huntley)
// ---------------------------------------------------------------------------
const evaluate = (codex: CodexLLM["Type"], goal: string, agentOutput: string) =>
  codex
    .generateText(
      `You are evaluating whether an AI agent has completed a task.

GOAL: ${goal}

AGENT OUTPUT:
${agentOutput}

Has the goal been fully achieved? Respond with EXACTLY one of:
- "DONE" if the goal is complete
- "CONTINUE: <what still needs to be done>" if more work is needed
- "FAILED: <reason>" if the approach is fundamentally broken`
    )
    .pipe(
      Effect.map((text) => {
        const trimmed = text.trim()
        if (trimmed.startsWith("DONE")) return { done: true as const, reason: "complete" }
        if (trimmed.startsWith("FAILED")) return { done: true as const, reason: trimmed }
        return { done: false as const, reason: trimmed.replace("CONTINUE: ", "") }
      }),
      Effect.catchAll((e) =>
        Effect.succeed({ done: false as const, reason: `Evaluation error: ${e.message}` })
      )
    )

// ---------------------------------------------------------------------------
// The Ralph loop itself
// ---------------------------------------------------------------------------
export const ralph = (config: RalphConfig) =>
  Effect.gen(function* () {
    const codex = yield* CodexLLM

    yield* Console.log(`\x1b[95m[ralph]\x1b[0m Goal: ${config.goal}`)
    yield* Console.log(`\x1b[95m[ralph]\x1b[0m Max iterations: ${config.maxIterations}`)
    yield* Console.log("")

    // Create a persistent thread for the agent work
    const agentThreadId = yield* codex.createThread()
    yield* Console.log(`\x1b[95m[ralph]\x1b[0m Agent thread: ${agentThreadId}`)

    let currentGoal = config.goal
    let iteration = 0

    while (iteration < config.maxIterations) {
      iteration++
      yield* Console.log(
        `\x1b[95m[ralph]\x1b[0m === Iteration ${iteration}/${config.maxIterations} ===`
      )

      // Run the agent — Codex handles the full tool loop internally
      const response = yield* codex.sendTurn(agentThreadId, currentGoal).pipe(
        Effect.catchAll((e) => Effect.succeed(`Error: ${e.message}`))
      )

      if (config.verbose) {
        yield* Console.log(`\x1b[93m[agent]\x1b[0m ${response}`)
      }

      // Evaluate — Codex-as-judge (uses ephemeral thread via generateText)
      yield* Console.log(`\x1b[96m[eval]\x1b[0m Evaluating...`)
      const result = yield* evaluate(codex, config.goal, response)

      if (result.done) {
        yield* Console.log(`\x1b[92m[ralph]\x1b[0m ${result.reason}`)
        yield* codex.archiveThread(agentThreadId).pipe(Effect.catchAll(() => Effect.void))
        return { iterations: iteration, result: response }
      }

      // Refine — feed evaluation back as next goal
      yield* Console.log(`\x1b[93m[ralph]\x1b[0m Continuing: ${result.reason}`)
      currentGoal = [
        `Original goal: ${config.goal}`,
        `\nPrevious attempt output:\n${response}`,
        `\nWhat still needs to be done: ${result.reason}`,
        `\nPlease continue working on the original goal.`
      ].join("\n")
    }

    yield* Console.log(`\x1b[91m[ralph]\x1b[0m Hit max iterations (${config.maxIterations})`)
    yield* codex.archiveThread(agentThreadId).pipe(Effect.catchAll(() => Effect.void))
    return { iterations: iteration, result: "max iterations reached" }
  })

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
const goal = process.argv[2]

if (!goal) {
  console.log("Usage: npx tsx src/ralph.ts <goal>")
  console.log('Example: npx tsx src/ralph.ts "create a fizzbuzz.js file and verify it works"')
  process.exit(1)
}

const main = ralph({
  goal,
  maxIterations: parseInt(process.argv[3] || "10", 10),
  verbose: process.argv.includes("--verbose")
}).pipe(
  Effect.provide(CodexLLMLive),
  Effect.catchAll((e) => Console.log(`Ralph failed: ${e}`))
)

Effect.runPromise(main).catch(console.error)
