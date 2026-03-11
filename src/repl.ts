/**
 * repl.ts — Terminal REPL for the Ralph Orchestrator.
 *
 * Fork multiple ralph loops, monitor their status, send messages,
 * interrupt, pause/resume — all from one terminal.
 *
 * Usage: npx tsx src/repl.ts
 */
import { Console, Effect, Queue } from "effect"
import { Orchestrator, OrchestratorLive } from "./orchestrator.js"
import { CodexLLMLive } from "./codex-client.js"
import { LoopMessage as LM } from "./loop-types.js"
import type { LoopState, LoopEvent } from "./loop-types.js"
import * as readline from "node:readline"

// ---------------------------------------------------------------------------
// Command types
// ---------------------------------------------------------------------------
type Command =
  | { _tag: "fork"; id: string; goal: string; maxIter: number }
  | { _tag: "status"; id?: string }
  | { _tag: "interrupt"; id: string }
  | { _tag: "send"; id: string; text: string }
  | { _tag: "goal"; id: string; goal: string }
  | { _tag: "pause"; id: string }
  | { _tag: "resume"; id: string }
  | { _tag: "maxiter"; id: string; max: number }
  | { _tag: "help" }
  | { _tag: "quit" }

// ---------------------------------------------------------------------------
// Command parser
// ---------------------------------------------------------------------------
const parseCommand = (input: string): Command | null => {
  const parts = input.trim().split(/\s+/)
  const cmd = parts[0]?.toLowerCase()

  switch (cmd) {
    case "fork": {
      // fork <id> <maxIter> <goal...>
      const id = parts[1]
      const maxIter = parseInt(parts[2] || "10", 10)
      const goal = parts.slice(3).join(" ")
      if (!id || !goal || isNaN(maxIter)) return null
      return { _tag: "fork", id, goal, maxIter }
    }
    case "status":
    case "s":
      return { _tag: "status", id: parts[1] }
    case "interrupt":
    case "kill":
      return parts[1] ? { _tag: "interrupt", id: parts[1] } : null
    case "send":
    case "msg": {
      const id = parts[1]
      const text = parts.slice(2).join(" ")
      return id && text ? { _tag: "send", id, text } : null
    }
    case "goal": {
      const id = parts[1]
      const goal = parts.slice(2).join(" ")
      return id && goal ? { _tag: "goal", id, goal } : null
    }
    case "pause":
      return parts[1] ? { _tag: "pause", id: parts[1] } : null
    case "resume":
      return parts[1] ? { _tag: "resume", id: parts[1] } : null
    case "maxiter": {
      const id = parts[1]
      const max = parseInt(parts[2] || "0", 10)
      return id && max > 0 ? { _tag: "maxiter", id, max } : null
    }
    case "help":
    case "h":
    case "?":
      return { _tag: "help" }
    case "quit":
    case "exit":
    case "q":
      return { _tag: "quit" }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------
const formatState = (s: LoopState): string => {
  const statusColor: Record<string, string> = {
    running: "\x1b[92m",
    paused: "\x1b[93m",
    done: "\x1b[96m",
    failed: "\x1b[91m",
    interrupted: "\x1b[90m"
  }
  const color = statusColor[s.status] ?? "\x1b[0m"
  const elapsed = ((Date.now() - s.startedAt) / 1000).toFixed(0)

  return [
    `  ${color}${s.id}\x1b[0m [${s.status}]`,
    `    Iteration: ${s.iteration}/${s.maxIterations} (${elapsed}s)`,
    `    Goal: ${s.goal.slice(0, 80)}`,
    s.lastAgentOutput ? `    Last output: ${s.lastAgentOutput.slice(0, 120)}...` : "",
    s.lastEvalResult ? `    Eval: ${s.lastEvalResult.slice(0, 100)}` : ""
  ].filter(Boolean).join("\n")
}

const formatEvent = (event: LoopEvent): string => {
  switch (event._tag) {
    case "Started":
      return `\x1b[92m[event]\x1b[0m Loop "${event.id}" started: ${event.goal.slice(0, 60)}`
    case "IterationComplete":
      return `\x1b[96m[event]\x1b[0m Loop "${event.id}" iteration ${event.iteration}: ${event.evalResult.slice(0, 80)}`
    case "Done":
      return `\x1b[92m[event]\x1b[0m Loop "${event.id}" done after ${event.iterations} iteration(s)`
    case "Failed":
      return `\x1b[91m[event]\x1b[0m Loop "${event.id}" failed: ${event.error}`
    case "Interrupted":
      return `\x1b[93m[event]\x1b[0m Loop "${event.id}" interrupted`
  }
}

const HELP_TEXT = `
\x1b[1mRalph Orchestrator Commands\x1b[0m

  fork <id> <maxIter> <goal...>   Fork a new ralph loop
  status [id]                     Show loop status (all or specific)
  interrupt <id>                  Interrupt a running loop
  send <id> <message...>          Inject user message into loop
  goal <id> <new goal...>         Override a loop's goal
  pause <id>                      Pause after current iteration
  resume <id>                     Resume a paused loop
  maxiter <id> <n>                Change max iterations
  help                            Show this help
  quit                            Exit orchestrator
`.trim()

// ---------------------------------------------------------------------------
// REPL loop
// ---------------------------------------------------------------------------
const repl = Effect.gen(function* () {
  const orch = yield* Orchestrator

  // Subscribe to lifecycle events and log them in background
  const eventSub = yield* orch.subscribe()
  yield* Effect.fork(
    Effect.forever(
      Effect.gen(function* () {
        const event = yield* Queue.take(eventSub)
        yield* Console.log(formatEvent(event))
      })
    )
  )

  // readline REPL
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  const prompt = (q: string): Effect.Effect<string, Error> =>
    Effect.async<string, Error>((resume) => {
      rl.question(q, (answer) => resume(Effect.succeed(answer)))
      rl.once("close", () => resume(Effect.fail(new Error("EOF"))))
    })

  yield* Console.log("")
  yield* Console.log(HELP_TEXT)
  yield* Console.log("")

  yield* Effect.forever(
    Effect.gen(function* () {
      const input = yield* prompt("\x1b[95morch>\x1b[0m ")
      if (input.trim() === "") return

      const cmd = parseCommand(input)
      if (!cmd) {
        yield* Console.log("Unknown command. Type 'help' for usage.")
        return
      }

      switch (cmd._tag) {
        case "fork": {
          yield* orch
            .fork({
              id: cmd.id,
              goal: cmd.goal,
              maxIterations: cmd.maxIter,
              verbose: true
            })
            .pipe(
              Effect.tap((id) => Console.log(`Forked loop: ${id}`)),
              Effect.catchAll((e) => Console.log(`Error: ${e}`))
            )
          break
        }

        case "status": {
          if (cmd.id) {
            yield* orch.status(cmd.id).pipe(
              Effect.tap((state) => Console.log(formatState(state))),
              Effect.catchAll((e) => Console.log(e.message))
            )
          } else {
            yield* orch.statusAll().pipe(
              Effect.tap((all) => {
                if (all.length === 0) return Console.log("No loops.")
                return Effect.forEach(all, (s) => Console.log(formatState(s)))
              })
            )
          }
          break
        }

        case "interrupt": {
          yield* orch.interrupt(cmd.id).pipe(
            Effect.tap(() => Console.log(`Interrupted: ${cmd.id}`)),
            Effect.catchAll((e) => Console.log(e.message))
          )
          break
        }

        case "send": {
          yield* orch.send(cmd.id, LM.UserMessage({ text: cmd.text })).pipe(
            Effect.tap(() => Console.log(`Sent message to: ${cmd.id}`)),
            Effect.catchAll((e) => Console.log(e.message))
          )
          break
        }

        case "goal": {
          yield* orch.send(cmd.id, LM.SetGoal({ goal: cmd.goal })).pipe(
            Effect.tap(() => Console.log(`Goal updated for: ${cmd.id}`)),
            Effect.catchAll((e) => Console.log(e.message))
          )
          break
        }

        case "pause": {
          yield* orch.send(cmd.id, LM.Pause()).pipe(
            Effect.tap(() => Console.log(`Pause sent to: ${cmd.id}`)),
            Effect.catchAll((e) => Console.log(e.message))
          )
          break
        }

        case "resume": {
          yield* orch.send(cmd.id, LM.Resume()).pipe(
            Effect.tap(() => Console.log(`Resume sent to: ${cmd.id}`)),
            Effect.catchAll((e) => Console.log(e.message))
          )
          break
        }

        case "maxiter": {
          yield* orch.send(cmd.id, LM.SetMaxIterations({ max: cmd.max })).pipe(
            Effect.tap(() => Console.log(`Max iterations updated for: ${cmd.id}`)),
            Effect.catchAll((e) => Console.log(e.message))
          )
          break
        }

        case "help":
          yield* Console.log(HELP_TEXT)
          break

        case "quit":
          rl.close()
          return yield* Effect.fail(new Error("quit"))
      }
    })
  ).pipe(
    Effect.catchAll(() => Effect.void)
  )

  rl.close()
})

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const main = repl.pipe(
  Effect.provide(OrchestratorLive),
  Effect.provide(CodexLLMLive),
  Effect.scoped,
  Effect.catchAll((e) => Console.log(`Orchestrator failed: ${e}`))
)

Effect.runPromise(main)
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
