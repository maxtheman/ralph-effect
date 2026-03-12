/**
 * run-build-compiler.ts — Build the OpenProse->Ralph compiler using ralph itself.
 *
 * Three agents, two rounds:
 *   Round 1: Implementer writes the code
 *   Round 1: Architect + Critic review (after implementer finishes)
 *   Round 2: Implementer addresses feedback
 *
 * This is the first app built on top of the ralph orchestrator.
 *
 * Usage: npx tsx examples/run-build-compiler.ts
 */
import { Effect, Queue, Console } from "effect"
import { Orchestrator, OrchestratorLive } from "../src/orchestrator.js"
import { CodexLLMLive } from "../src/codex-client.js"
import type { LoopEvent } from "../src/loop-types.js"

// ---------------------------------------------------------------------------
// Agent configs
// ---------------------------------------------------------------------------
const implementerAgent = {
  personality: [
    "You are a senior TypeScript developer.",
    "You write clean, well-documented code.",
    "You follow the spec exactly and produce working code with zero TypeScript errors.",
    "You read the full spec before writing any code.",
    "You write all files in a single pass, then run tsc to verify."
  ].join(" "),
  sandbox: "workspace-write" as const,
  writableRoots: ["src/dsl", ".ralph/reviews"],
  model: "gpt-5.3-codex-spark",
  reasoningEffort: "high" as const
}

const architectAgent = {
  personality: [
    "You are a software architect who reviews code for API design, type safety, and adherence to specifications.",
    "You read the spec and the implementation, then write a detailed review focusing on correctness, missing edge cases, and API ergonomics.",
    "You are constructive but thorough."
  ].join(" "),
  sandbox: "workspace-write" as const,
  writableRoots: [".ralph/reviews"],
  model: "gpt-5.3-codex-spark",
  reasoningEffort: "medium" as const
}

const criticAgent = {
  personality: [
    "You are a QA engineer and code critic.",
    "You look for bugs, missing error handling, spec violations, and test gaps.",
    "You try to break the implementation by thinking of edge cases.",
    "You write specific, actionable feedback with file and line references."
  ].join(" "),
  sandbox: "workspace-write" as const,
  writableRoots: [".ralph/reviews"],
  model: "gpt-5.3-codex-spark",
  reasoningEffort: "medium" as const
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------
const implementerGoalR1 = [
  "Read the compiler specification at specs/prose-compiler.md.",
  "Read the existing types at src/loop-types.ts and src/orchestrator.ts.",
  "Implement the full compiler in src/dsl/ following the spec exactly.",
  "Create these files:",
  "  - src/dsl/ast.ts (AST types — discriminated unions for every syntax node)",
  "  - src/dsl/parser.ts (recursive descent parser — .prose text to AST)",
  "  - src/dsl/compiler.ts (AST to Effect compiler using Orchestrator service)",
  "  - src/dsl/checks.ts (built-in check evaluators: file-exists, file-not-empty, json-valid, tests-pass)",
  "  - src/dsl/evaluators.ts (evaluator routing: self, agent, check)",
  "  - src/dsl/index.ts (public API: loadWorkflow, runWorkflow, re-exports)",
  "  - src/dsl/cli.ts (CLI entry point: npx tsx src/dsl/cli.ts <workflow.prose>)",
  "After writing all files, run: npx tsc --noEmit",
  "Fix any TypeScript errors until compilation is clean.",
  "The parser must handle all 7 test cases from the spec."
].join("\n")

const architectGoal = [
  "Read the spec at specs/prose-compiler.md.",
  "Read all files in src/dsl/ that the implementer created.",
  "Write a detailed architecture review to .ralph/reviews/architect.md covering:",
  "1. Does the implementation match the spec?",
  "2. Are the AST types complete and correct?",
  "3. Is the parser handling all syntax cases from the spec?",
  "4. Is the compiler producing correct orchestrator calls?",
  "5. Are there any type safety issues?",
  "6. API ergonomics: is the public interface clean?",
  "Be specific: reference file names and line numbers."
].join("\n")

const criticGoal = [
  "Read the spec at specs/prose-compiler.md.",
  "Read all files in src/dsl/ that the implementer created.",
  "Write a detailed critique to .ralph/reviews/critic.md covering:",
  "1. Try to break the parser with edge cases (empty files, bad indentation, missing fields)",
  "2. Check error handling: do parse/compile errors report line numbers?",
  "3. Check the acceptance criteria from the spec — which ones are NOT met?",
  "4. Look for bugs in the compiler logic (topological sort, variable interpolation)",
  "5. Check that imports use .js extensions and types are imported correctly",
  "Be specific: reference file names, line numbers, and exact issues."
].join("\n")

const implementerGoalR2 = [
  "Read the architecture review at .ralph/reviews/architect.md.",
  "Read the critique at .ralph/reviews/critic.md.",
  "Address every issue raised by the architect and critic.",
  "Fix bugs, add missing error handling, improve the implementation.",
  "After fixing, run: npx tsc --noEmit",
  "Ensure TypeScript compiles with zero errors.",
  "Report what you fixed and what was already correct."
].join("\n")

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const run = Effect.gen(function* () {
  const orch = yield* Orchestrator

  // Subscribe to lifecycle events and log them
  const sub = yield* orch.subscribe()
  yield* Effect.fork(
    Effect.forever(
      Effect.gen(function* () {
        const event: LoopEvent = yield* Queue.take(sub)
        const tag = event._tag
        switch (tag) {
          case "Started":
            yield* Console.log(`\x1b[92m[event]\x1b[0m ${event.id} started`)
            break
          case "IterationComplete":
            yield* Console.log(`\x1b[96m[event]\x1b[0m ${event.id} iteration ${event.iteration}: ${event.evalResult.slice(0, 100)}`)
            break
          case "Done":
            yield* Console.log(`\x1b[92m[event]\x1b[0m ${event.id} done after ${event.iterations} iteration(s)`)
            break
          case "Failed":
            yield* Console.log(`\x1b[91m[event]\x1b[0m ${event.id} failed: ${event.error}`)
            break
          case "Interrupted":
            yield* Console.log(`\x1b[93m[event]\x1b[0m ${event.id} interrupted`)
            break
        }
      })
    )
  )

  // ------- Fork all loops -------
  // forkAfter blocks the calling fiber until deps complete, so we use
  // Effect.fork to launch them concurrently. The dependency ordering
  // is handled internally by forkAfter (waits for Done events).
  // No pipes needed — agents read/write files directly via their goals.

  yield* Console.log("\n\x1b[1m=== Launching build loop: implementer -> architect + critic -> implementer ===\x1b[0m\n")

  // Round 1: Implementer writes the compiler (no deps, starts immediately)
  yield* orch.fork({
    id: "implementer-r1",
    goal: implementerGoalR1,
    maxIterations: 5,
    verbose: true,
    agent: implementerAgent
  })

  // Round 1: Architect reviews (waits for implementer-r1, runs in background)
  yield* Effect.fork(
    orch.forkAfter(
      {
        id: "architect",
        goal: architectGoal,
        maxIterations: 2,
        verbose: true,
        agent: architectAgent
      },
      ["implementer-r1"]
    )
  )

  // Round 1: Critic reviews (waits for implementer-r1, runs in background)
  yield* Effect.fork(
    orch.forkAfter(
      {
        id: "critic",
        goal: criticGoal,
        maxIterations: 2,
        verbose: true,
        agent: criticAgent
      },
      ["implementer-r1"]
    )
  )

  // Round 2: Implementer addresses feedback (waits for architect + critic)
  yield* Effect.fork(
    orch.forkAfter(
      {
        id: "implementer-r2",
        goal: implementerGoalR2,
        maxIterations: 5,
        verbose: true,
        agent: implementerAgent
      },
      ["architect", "critic"]
    )
  )

  // Wait for everything
  yield* orch.awaitAll()

  // ------- Final Status -------
  yield* Console.log("\n\x1b[1m=== FINAL STATUS ===\x1b[0m\n")
  const states = yield* orch.statusAll()
  for (const s of states) {
    const statusColor: Record<string, string> = {
      running: "\x1b[92m",
      done: "\x1b[96m",
      failed: "\x1b[91m",
      interrupted: "\x1b[93m"
    }
    const color = statusColor[s.status] ?? "\x1b[0m"
    yield* Console.log(
      `  ${color}${s.id}\x1b[0m [${s.status}] — ${s.iteration}/${s.maxIterations} iterations`
    )
  }
})

const main = run.pipe(
  Effect.provide(OrchestratorLive),
  Effect.provide(CodexLLMLive),
  Effect.scoped,
  Effect.catchAll((e) => Console.log(`Build failed: ${e}`))
)

Effect.runPromise(main)
  .then(() => {
    console.log("\n=== Build Complete ===")
    process.exit(0)
  })
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
