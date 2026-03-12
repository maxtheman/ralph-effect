/**
 * run-poetry-loop.ts — Demonstrate the poet <-> critic pipe pattern.
 *
 * Forks two ralph loops:
 *   - poet: generates/refines a poem
 *   - critic: critiques the poet's output
 *
 * Pipes them bidirectionally so they iterate on each other's work.
 *
 * Usage: npx tsx examples/run-poetry-loop.ts
 */
import { Effect, Queue, Console } from "effect"
import { Orchestrator, OrchestratorLive } from "../src/orchestrator.js"
import { CodexLLMLive } from "../src/codex-client.js"
import type { LoopEvent } from "../src/loop-types.js"

const poetGoal = [
  "Write an original 4-stanza poem about recursion and self-reference.",
  "The poem should use concrete imagery (not abstract platitudes).",
  "Each stanza should have 4 lines with roughly consistent meter.",
  "Write the poem to examples/ralph-poem.md"
].join("\n")

const criticGoal = [
  "You are a poetry critic. When you receive context from the poet loop,",
  "read the poem at examples/ralph-poem.md and write a sharp critique",
  "to examples/ralph-critique.md.",
  "Focus on: imagery strength, metric consistency, avoiding cliche.",
  "Suggest specific line-level rewrites.",
  "If no poem exists yet, wait for context."
].join("\n")

const run = Effect.gen(function* () {
  const orch = yield* Orchestrator

  // Subscribe to lifecycle events and log them
  const sub = yield* orch.subscribe()
  yield* Effect.fork(
    Effect.forever(
      Effect.gen(function* () {
        const event: LoopEvent = yield* Queue.take(sub)
        const preview = JSON.stringify(event).slice(0, 200)
        yield* Console.log("[event] " + event._tag + ": " + preview)
      })
    )
  )

  // Fork the poet loop
  yield* Console.log("=== Forking poet loop ===")
  yield* orch.fork({
    id: "poet",
    goal: poetGoal,
    maxIterations: 3,
    verbose: true
  })

  // Fork the critic loop
  yield* Console.log("=== Forking critic loop ===")
  yield* orch.fork({
    id: "critic",
    goal: criticGoal,
    maxIterations: 3,
    verbose: true
  })

  // Wire pipes using different strategies:
  //   poet -> critic via file (poet writes poem, critic reads it)
  //   critic -> poet via notify (light signal, poet reads critique file directly)
  yield* orch.pipe({
    from: "poet",
    to: "critic",
    on: "iteration",
    strategy: { _tag: "file", path: "examples/ralph-poem.md" }
  })
  yield* orch.pipe({
    from: "critic",
    to: "poet",
    on: "iteration",
    strategy: { _tag: "notify" }
  })

  yield* Console.log("=== Pipes wired: poet <-> critic ===")
  yield* Console.log("=== Awaiting completion ===")

  // Wait for both loops to finish
  yield* orch.awaitAll()

  // Print final status
  yield* Console.log("")
  yield* Console.log("=== Final Status ===")
  const states = yield* orch.statusAll()
  for (const s of states) {
    yield* Console.log(s.id + ": " + s.status + " (" + s.iteration + "/" + s.maxIterations + " iterations)")
    if (s.lastEvalResult) {
      yield* Console.log("  Eval: " + s.lastEvalResult.slice(0, 200))
    }
  }
})

const main = run.pipe(
  Effect.provide(OrchestratorLive),
  Effect.provide(CodexLLMLive),
  Effect.scoped,
  Effect.catchAll((e) => Console.log("Orchestrator failed: " + String(e)))
)

Effect.runPromise(main)
  .then(() => {
    console.log("\n=== Done ===")
    process.exit(0)
  })
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
