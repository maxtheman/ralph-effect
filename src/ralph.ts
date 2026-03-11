/**
 * ralph.ts — The Ralph Wiggum Loop in Effect.ts
 *
 * The huntley pattern:
 *   1. Give the agent a goal
 *   2. Agent runs autonomously (tool loop is automatic via Effect)
 *   3. Evaluate: is the goal met?
 *   4. If not: feed errors/output back, refine, loop
 *   5. Watch the inferencing — you're on the loop, not in the loop
 *
 * This is Option C: the agent USES Codex as one backend AND
 * EXPOSES the Codex JSON-RPC protocol so other clients can drive it.
 */
import { LanguageModel, Chat } from "@effect/ai"
import { AnthropicLanguageModel, AnthropicClient } from "@effect/ai-anthropic"
import { NodeHttpClient } from "@effect/platform-node"
import { Console, Config, Effect, Layer, Ref } from "effect"
import { AgentToolkit } from "./tools.js"

// ---------------------------------------------------------------------------
// Ralph loop configuration
// ---------------------------------------------------------------------------
interface RalphConfig {
  goal: string
  maxIterations: number
  verbose: boolean
}

// ---------------------------------------------------------------------------
// The evaluation step — did the agent achieve the goal?
// Uses the LLM itself as the judge (recursive, very huntley)
// ---------------------------------------------------------------------------
const evaluate = (goal: string, agentOutput: string) =>
  LanguageModel.generateText({
    prompt: `You are evaluating whether an AI agent has completed a task.

GOAL: ${goal}

AGENT OUTPUT:
${agentOutput}

Has the goal been fully achieved? Respond with EXACTLY one of:
- "DONE" if the goal is complete
- "CONTINUE: <what still needs to be done>" if more work is needed
- "FAILED: <reason>" if the approach is fundamentally broken`
  }).pipe(
    Effect.map((response) => {
      const text = response.text.trim()
      if (text.startsWith("DONE")) return { done: true as const, reason: "complete" }
      if (text.startsWith("FAILED")) return { done: true as const, reason: text }
      return { done: false as const, reason: text.replace("CONTINUE: ", "") }
    })
  )

// ---------------------------------------------------------------------------
// The Ralph loop itself
// ---------------------------------------------------------------------------
const ralph = (config: RalphConfig) =>
  Effect.gen(function* () {
    const chat = yield* Chat.empty

    yield* Console.log(`\x1b[95m[ralph]\x1b[0m Goal: ${config.goal}`)
    yield* Console.log(`\x1b[95m[ralph]\x1b[0m Max iterations: ${config.maxIterations}`)
    yield* Console.log("")

    let currentGoal = config.goal
    let iteration = 0

    while (iteration < config.maxIterations) {
      iteration++
      yield* Console.log(`\x1b[95m[ralph]\x1b[0m === Iteration ${iteration}/${config.maxIterations} ===`)

      // Run the agent with the current goal + toolkit
      const response = yield* chat.generateText({
        prompt: currentGoal,
        toolkit: AgentToolkit
      })

      if (config.verbose) {
        yield* Console.log(`\x1b[93m[agent]\x1b[0m ${response.text}`)
      }

      // Evaluate
      yield* Console.log(`\x1b[96m[eval]\x1b[0m Evaluating...`)
      const result = yield* evaluate(config.goal, response.text)

      if (result.done) {
        yield* Console.log(`\x1b[92m[ralph]\x1b[0m ${result.reason}`)
        return { iterations: iteration, result: response.text }
      }

      // Refine — feed the evaluation back as the next goal
      yield* Console.log(`\x1b[93m[ralph]\x1b[0m Continuing: ${result.reason}`)
      currentGoal = `Original goal: ${config.goal}\n\nPrevious attempt output:\n${response.text}\n\nWhat still needs to be done: ${result.reason}\n\nPlease continue working on the original goal.`
    }

    yield* Console.log(`\x1b[91m[ralph]\x1b[0m Hit max iterations (${config.maxIterations})`)
    return { iterations: iteration, result: "max iterations reached" }
  })

// ---------------------------------------------------------------------------
// Provider layer
// ---------------------------------------------------------------------------
const AnthropicModel = AnthropicLanguageModel.model("claude-sonnet-4-20250514")

const AnthropicLive = AnthropicClient.layerConfig({
  apiKey: Config.redacted("ANTHROPIC_API_KEY")
}).pipe(Layer.provide(NodeHttpClient.layerUndici))

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
  Effect.provide(AnthropicModel),
  Effect.provide(AnthropicLive),
  Effect.catchAll((e) => Console.log(`Ralph failed: ${e}`))
)

Effect.runPromise(main).catch(console.error)
