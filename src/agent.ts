/**
 * agent.ts — The inner agent: a REPL with automatic tool loop.
 *
 * Geoff's double loop becomes a single loop here because Effect's
 * LanguageModel.generateText with a Toolkit auto-loops tool calls.
 * The inner tool loop is FREE — the framework does it.
 *
 * What remains: the outer REPL (read input → generate → print).
 */
import { LanguageModel } from "@effect/ai"
import { AnthropicLanguageModel, AnthropicClient } from "@effect/ai-anthropic"
import { NodeHttpClient } from "@effect/platform-node"
import { Console, Config, Effect, Layer } from "effect"
import { AgentToolkit, AgentToolkitLive } from "./tools.js"
import * as readline from "node:readline"

// ---------------------------------------------------------------------------
// REPL — the outer loop. Inner tool loop handled by framework.
// ---------------------------------------------------------------------------
const createRepl = Effect.gen(function* () {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  const prompt = (q: string): Effect.Effect<string, Error> =>
    Effect.async<string, Error>((resume) => {
      rl.question(q, (answer) => {
        resume(Effect.succeed(answer))
      })
      rl.once("close", () => {
        resume(Effect.fail(new Error("EOF")))
      })
    })

  yield* Console.log("Chat with Claude (use 'ctrl-c' to quit)")

  yield* Effect.forever(
    Effect.gen(function* () {
      const input = yield* prompt("\x1b[94mYou\x1b[0m: ")
      if (input.trim() === "") return

      yield* Console.log("\x1b[96m[thinking...]\x1b[0m")

      const response = yield* LanguageModel.generateText({
        prompt: input,
        toolkit: AgentToolkit
      })

      yield* Console.log(`\x1b[93mClaude\x1b[0m: ${response.text}`)
    })
  ).pipe(Effect.catchAll((e) => Console.log(`\nSession ended: ${e}`)))

  rl.close()
})

// ---------------------------------------------------------------------------
// Provider layer — swap this one line to change models
// ---------------------------------------------------------------------------
const AnthropicModel = AnthropicLanguageModel.model("claude-sonnet-4-20250514")

const AnthropicLive = AnthropicClient.layerConfig({
  apiKey: Config.redacted("ANTHROPIC_API_KEY")
}).pipe(Layer.provide(NodeHttpClient.layerUndici))

// ---------------------------------------------------------------------------
// Run — provide model, provider HTTP, and tool handlers
// ---------------------------------------------------------------------------
const main = createRepl.pipe(
  Effect.provide(AgentToolkitLive),
  Effect.provide(AnthropicModel),
  Effect.provide(AnthropicLive)
)

Effect.runPromise(main).catch(console.error)
