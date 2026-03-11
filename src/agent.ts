/**
 * agent.ts — The inner agent: a REPL backed by Codex.
 *
 * The outer loop is a simple REPL (read input → send to Codex → print).
 * The inner tool loop is handled by Codex itself — it has its own tools
 * (file read, edit, bash, search) and runs them autonomously.
 *
 * No Anthropic key needed. Just `codex login`.
 */
import { Console, Effect } from "effect"
import { CodexLLM, CodexLLMLive } from "./codex-client.js"
import * as readline from "node:readline"

// ---------------------------------------------------------------------------
// REPL — the outer loop. Inner tool loop handled by Codex.
// ---------------------------------------------------------------------------
const createRepl = Effect.gen(function* () {
  const codex = yield* CodexLLM

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

  // Create a persistent thread for the conversation
  const threadId = yield* codex.createThread()
  yield* Console.log(`Chat with Codex (thread: ${threadId}) — use 'ctrl-c' to quit`)

  yield* Effect.forever(
    Effect.gen(function* () {
      const input = yield* prompt("\x1b[94mYou\x1b[0m: ")
      if (input.trim() === "") return

      yield* Console.log("\x1b[96m[thinking...]\x1b[0m")

      const response = yield* codex.sendTurn(threadId, input).pipe(
        Effect.catchAll((e) => Effect.succeed(`Error: ${e.message}`))
      )

      yield* Console.log(`\x1b[93mCodex\x1b[0m: ${response}`)
    })
  ).pipe(
    Effect.catchAll((e) => Console.log(`\nSession ended: ${e}`))
  )

  yield* codex.archiveThread(threadId).pipe(Effect.catchAll(() => Effect.void))
  rl.close()
})

// ---------------------------------------------------------------------------
// Run — provide Codex backend
// ---------------------------------------------------------------------------
const main = createRepl.pipe(
  Effect.provide(CodexLLMLive),
  Effect.catchAll((e) => Console.log(`Agent failed: ${e}`))
)

Effect.runPromise(main).catch(console.error)
