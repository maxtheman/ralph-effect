/**
 * codex-server.ts — Exposes the Ralph agent via the Codex App Server protocol.
 *
 * JSON-RPC 2.0 over stdio (newline-delimited JSON).
 * Implements the core Codex primitives:
 *   - Thread (conversation)
 *   - Turn (user request → agent work)
 *   - Item (individual tool calls, file changes, messages)
 *
 * This is the "product is the IDE" half of Option C:
 * other clients (VS Code, web apps) can drive this agent
 * using the same protocol Codex uses.
 */
import { LanguageModel, Chat } from "@effect/ai"
import { AnthropicLanguageModel, AnthropicClient } from "@effect/ai-anthropic"
import { NodeHttpClient } from "@effect/platform-node"
import { Console, Config, Effect, Layer, Ref, HashMap } from "effect"
import { AgentToolkit } from "./tools.js"
import * as readline from "node:readline"

// ---------------------------------------------------------------------------
// Types — Codex primitives
// ---------------------------------------------------------------------------
type ThreadId = string
type TurnId = string

interface Thread {
  id: ThreadId
  chat: Effect.Effect<Chat.Chat, never, LanguageModel.LanguageModel>
  turns: TurnId[]
  createdAt: string
  archived: boolean
}

interface JsonRpcRequest {
  jsonrpc: "2.0"
  method: string
  params?: Record<string, unknown>
  id?: string | number
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let initialized = false
const threads = new Map<string, Thread>()
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

const send = (msg: JsonRpcResponse | JsonRpcNotification) => {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------
const handleMethod = (req: JsonRpcRequest): Effect.Effect<void, never, LanguageModel.LanguageModel> =>
  Effect.gen(function* () {
    const { method, params, id } = req

    // Gate: require initialization
    if (!initialized && method !== "initialize") {
      if (id != null) send(respondError(id, -32002, "Not initialized"))
      return
    }

    switch (method) {
      // --- Handshake ---
      case "initialize": {
        initialized = true
        if (id != null) {
          send(respond(id, {
            serverInfo: {
              name: "ralph-effect",
              version: "1.0.0"
            },
            capabilities: {
              threads: true,
              tools: true,
              streaming: false
            }
          }))
        }
        break
      }

      case "initialized": {
        // Notification — no response needed
        yield* Console.log("[codex-server] Handshake complete")
        break
      }

      // --- Thread management ---
      case "thread/start": {
        const threadId = `thread_${++threadCounter}`
        const thread: Thread = {
          id: threadId,
          chat: Chat.empty,
          turns: [],
          createdAt: new Date().toISOString(),
          archived: false
        }
        threads.set(threadId, thread)
        send(notify("thread/status/changed", { threadId, status: "active" }))
        if (id != null) send(respond(id, { threadId }))
        break
      }

      case "thread/list": {
        const threadList = [...threads.values()]
          .filter((t) => !t.archived)
          .map((t) => ({
            id: t.id,
            turns: t.turns.length,
            createdAt: t.createdAt
          }))
        if (id != null) send(respond(id, { threads: threadList }))
        break
      }

      case "thread/archive": {
        const threadId = params?.threadId as string
        const thread = threads.get(threadId)
        if (thread) {
          thread.archived = true
          send(notify("thread/status/changed", { threadId, status: "archived" }))
        }
        if (id != null) send(respond(id, { success: !!thread }))
        break
      }

      // --- Turn operations ---
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

        // Run the agent — this is where the ralph loop could wrap
        const chat = yield* thread.chat
        const response = yield* chat.generateText({
          prompt,
          toolkit: AgentToolkit
        }).pipe(
          Effect.catchAll((e) =>
            Effect.succeed({ text: `Error: ${e}`, parts: [] } as any)
          )
        )

        // Emit items
        send(notify("item/started", { turnId, type: "message" }))
        send(
          notify("item/completed", {
            turnId,
            type: "message",
            content: response.text
          })
        )

        send(notify("turn/completed", { threadId, turnId }))

        if (id != null) {
          send(respond(id, { turnId, text: response.text }))
        }
        break
      }

      case "turn/interrupt": {
        // TODO: cancellation via Effect.Fiber
        if (id != null) send(respond(id, { interrupted: true }))
        break
      }

      // --- Discovery ---
      case "model/list": {
        if (id != null) {
          send(respond(id, {
            models: [
              { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" }
            ]
          }))
        }
        break
      }

      case "skills/list": {
        if (id != null) {
          send(respond(id, {
            skills: [
              { name: "read_file", description: "Read file contents" },
              { name: "list_files", description: "List directory contents" },
              { name: "bash", description: "Execute shell commands" },
              { name: "edit_file", description: "Edit file contents" },
              { name: "code_search", description: "Search code with ripgrep" }
            ]
          }))
        }
        break
      }

      default: {
        if (id != null) {
          send(respondError(id, -32601, `Method not found: ${method}`))
        }
      }
    }
  })

// ---------------------------------------------------------------------------
// Provider layer
// ---------------------------------------------------------------------------
const AnthropicModel = AnthropicLanguageModel.model("claude-sonnet-4-20250514")

const AnthropicLive = AnthropicClient.layerConfig({
  apiKey: Config.redacted("ANTHROPIC_API_KEY")
}).pipe(Layer.provide(NodeHttpClient.layerUndici))

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
        Effect.runPromise(
          handleMethod(req).pipe(
            Effect.provide(AnthropicModel),
            Effect.provide(AnthropicLive)
          )
        ).catch((e) => {
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
