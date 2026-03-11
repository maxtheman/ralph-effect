/**
 * codex-server.ts — Exposes the Ralph agent via the Codex App Server protocol.
 *
 * JSON-RPC 2.0 over stdio (newline-delimited JSON).
 * Implements the core Codex primitives:
 *   - Thread (conversation)
 *   - Turn (user request → agent work)
 *   - Item (individual tool calls, file changes, messages)
 *
 * This makes ralph-effect act AS a Codex server, so IDEs and other
 * clients can connect to it. Internally delegates to the Codex backend
 * for LLM processing.
 *
 * No Anthropic key needed. Just `codex login`.
 */
import { Console, Effect } from "effect"
import { CodexLLM, CodexLLMLive } from "./codex-client.js"
import * as readline from "node:readline"

// ---------------------------------------------------------------------------
// Types — Codex JSON-RPC protocol
// ---------------------------------------------------------------------------
interface JsonRpcRequest {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly params?: Record<string, unknown>
  readonly id?: string | number
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0"
  readonly id: string | number | null
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

interface JsonRpcNotification {
  readonly jsonrpc: "2.0"
  readonly method: string
  readonly params?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Types — Thread state
// ---------------------------------------------------------------------------
interface ThreadState {
  readonly id: string
  readonly codexThreadId: string // The underlying Codex thread
  readonly turns: string[]
  readonly createdAt: string
  archived: boolean
}

// ---------------------------------------------------------------------------
// Mutable server state
// ---------------------------------------------------------------------------
let initialized = false
const threads = new Map<string, ThreadState>()
let threadCounter = 0
let turnCounter = 0

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------
const respond = (id: string | number | null, result: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  result
})

const respondError = (
  id: string | number | null,
  code: number,
  message: string
): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message }
})

const notify = (method: string, params?: Record<string, unknown>): JsonRpcNotification => ({
  jsonrpc: "2.0",
  method,
  params
})

const send = (msg: JsonRpcResponse | JsonRpcNotification): void => {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

// ---------------------------------------------------------------------------
// Method handler — delegates to Codex backend
// ---------------------------------------------------------------------------
const handleMethod = (req: JsonRpcRequest) =>
  Effect.gen(function* () {
    const codex = yield* CodexLLM
    const { method, params, id } = req

    if (!initialized && method !== "initialize") {
      if (id != null) send(respondError(id, -32002, "Not initialized"))
      return
    }

    switch (method) {
      case "initialize": {
        initialized = true
        if (id != null) {
          send(
            respond(id, {
              serverInfo: { name: "ralph-effect", version: "1.0.0" },
              capabilities: { threads: true, tools: true, streaming: false }
            })
          )
        }
        break
      }

      case "initialized": {
        yield* Console.log("[codex-server] Handshake complete")
        break
      }

      case "thread/start": {
        const localId = `thread_${++threadCounter}`
        // Create a real Codex thread as the backend
        const codexThreadId = yield* codex.createThread().pipe(
          Effect.catchAll(() => Effect.succeed(`local_${localId}`))
        )

        threads.set(localId, {
          id: localId,
          codexThreadId,
          turns: [],
          createdAt: new Date().toISOString(),
          archived: false
        })
        send(notify("thread/status/changed", { threadId: localId, status: "active" }))
        if (id != null) send(respond(id, { threadId: localId }))
        break
      }

      case "thread/list": {
        const list = [...threads.values()]
          .filter((t) => !t.archived)
          .map((t) => ({ id: t.id, turns: t.turns.length, createdAt: t.createdAt }))
        if (id != null) send(respond(id, { threads: list }))
        break
      }

      case "thread/archive": {
        const threadId = params?.threadId as string
        const thread = threads.get(threadId)
        if (thread) {
          thread.archived = true
          yield* codex.archiveThread(thread.codexThreadId).pipe(
            Effect.catchAll(() => Effect.void)
          )
          send(notify("thread/status/changed", { threadId, status: "archived" }))
        }
        if (id != null) send(respond(id, { success: !!thread }))
        break
      }

      case "turn/start": {
        const threadId = params?.threadId as string
        const prompt = params?.prompt as string
        const thread = threads.get(threadId)

        if (!thread) {
          if (id != null) send(respondError(id, -32001, `Thread not found: ${threadId}`))
          return
        }

        const turnId = `turn_${++turnCounter}`
        thread.turns.push(turnId)
        send(notify("turn/started", { threadId, turnId }))

        // Delegate to Codex backend
        const response = yield* codex.sendTurn(thread.codexThreadId, prompt).pipe(
          Effect.catchAll((e) => Effect.succeed(`Error: ${e.message}`))
        )

        send(notify("item/started", { turnId, type: "message" }))
        send(notify("item/completed", { turnId, type: "message", content: response }))
        send(notify("turn/completed", { threadId, turnId }))

        if (id != null) send(respond(id, { turnId, text: response }))
        break
      }

      case "turn/interrupt": {
        if (id != null) send(respond(id, { interrupted: true }))
        break
      }

      case "model/list": {
        if (id != null) {
          send(
            respond(id, {
              models: [
                { id: "codex-default", name: "Codex Default Model", provider: "openai" }
              ]
            })
          )
        }
        break
      }

      case "skills/list": {
        if (id != null) {
          send(
            respond(id, {
              skills: [
                { name: "ReadFile", description: "Read file contents" },
                { name: "ListFiles", description: "List directory contents" },
                { name: "Bash", description: "Execute shell commands" },
                { name: "EditFile", description: "Edit file contents" },
                { name: "CodeSearch", description: "Search code with ripgrep" }
              ]
            })
          )
        }
        break
      }

      default: {
        if (id != null) send(respondError(id, -32601, `Method not found: ${method}`))
      }
    }
  })

// ---------------------------------------------------------------------------
// stdio transport — newline-delimited JSON-RPC
// ---------------------------------------------------------------------------
const server = Effect.gen(function* () {
  yield* Console.log("[codex-server] Ralph Effect Codex Server starting on stdio...")

  const rl = readline.createInterface({ input: process.stdin })

  yield* Effect.async<void, never>((resume) => {
    rl.on("line", (line) => {
      try {
        const req = JSON.parse(line) as JsonRpcRequest
        Effect.runPromise(handleMethod(req).pipe(Effect.provide(CodexLLMLive))).catch((e) => {
          if (req.id != null) {
            send(respondError(req.id, -32603, `Internal error: ${e}`))
          }
        })
      } catch {
        send(respondError(null, -32700, "Parse error"))
      }
    })

    rl.on("close", () => {
      resume(Effect.void)
    })
  })
})

Effect.runPromise(server).catch(console.error)
