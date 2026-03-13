/**
 * codex-client.ts — Effect Service wrapping the Codex CLI app-server.
 *
 * Spawns `codex app-server` as a child process and speaks JSON-RPC 2.0
 * over stdio. This IS the LLM backend — no Anthropic key needed.
 *
 * Auth: `codex login` (or OPENAI_API_KEY env var)
 *
 * Protocol: Codex App Server v2
 *   - thread/start → creates a conversation thread
 *   - turn/start   → sends user input, Codex runs full agent loop
 *   - Notifications stream back as turn progresses
 *   - turn/completed notification signals the turn is done
 *   - codex/event/agent_message carries the actual response text
 */
import { Context, Effect, Layer, Console } from "effect"
import * as childProcess from "node:child_process"
import * as readline from "node:readline"
import type { AgentConfig } from "./loop-types.js"

// ---------------------------------------------------------------------------
// Types — Codex v2 protocol
// ---------------------------------------------------------------------------
interface JsonRpcMessage {
  readonly jsonrpc: "2.0"
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly id?: number | string | null
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

interface UserInput {
  readonly type: "text"
  readonly text: string
}

interface ThreadItem {
  readonly id: string
  readonly type: string
  readonly text?: string
  readonly command?: string
  readonly aggregatedOutput?: string | null
  readonly phase?: string | null
}

interface Turn {
  readonly id: string
  readonly items: ThreadItem[]
  readonly status: "completed" | "interrupted" | "failed" | "inProgress"
  readonly error?: { readonly message: string }
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------
export interface CodexLLMService {
  /** One-shot: create ephemeral thread, send prompt, wait for completion, return text */
  readonly generateText: (prompt: string) => Effect.Effect<string, Error>
  /** Create a persistent thread with optional agent config (personality, sandbox) */
  readonly createThread: (config?: AgentConfig) => Effect.Effect<string, Error>
  /**
   * Send a turn to an existing thread, wait for completion.
   * Accepts either a single string (backward compat) or an array of input items.
   */
  readonly sendTurn: (
    threadId: string,
    input: string | ReadonlyArray<{ type: "text"; text: string }>
  ) => Effect.Effect<string, Error>
  /** Archive a thread */
  readonly archiveThread: (threadId: string) => Effect.Effect<void, Error>
  /** Graceful shutdown */
  readonly shutdown: () => Effect.Effect<void>
}

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------
export class CodexLLM extends Context.Tag("@ralph-effect/CodexLLM")<
  CodexLLM,
  CodexLLMService
>() {}

// ---------------------------------------------------------------------------
// JSON-RPC transport over stdio
// ---------------------------------------------------------------------------
class CodexTransport {
  private proc: childProcess.ChildProcess
  private rl: readline.Interface
  private requestId = 0
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  // Notification listeners keyed by method
  private listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>()

  constructor(proc: childProcess.ChildProcess) {
    this.proc = proc
    this.rl = readline.createInterface({ input: proc.stdout! })
    this.rl.on("line", (line) => this.handleLine(line))

    // Log stderr for debugging
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) console.error(`[codex:stderr] ${text}`)
    })
  }

  private handleLine(line: string): void {
    try {
      const msg = JSON.parse(line) as JsonRpcMessage

      // Response to a request we sent
      if (msg.id != null && typeof msg.id === "number" && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (msg.error) {
          reject(new Error(`[${msg.error.code}] ${msg.error.message}`))
        } else {
          resolve(msg.result)
        }
        return
      }

      // Server notification
      if (msg.method) {
        const handlers = this.listeners.get(msg.method)
        if (handlers) {
          for (const handler of handlers) {
            handler(msg.params ?? {})
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  /** Send a JSON-RPC request and await the response */
  call(method: string, params?: Record<string, unknown>): Effect.Effect<unknown, Error> {
    return Effect.async<unknown, Error>((resume) => {
      const id = ++this.requestId
      this.pending.set(id, {
        resolve: (v) => resume(Effect.succeed(v)),
        reject: (e) => resume(Effect.fail(e))
      })

      const msg = JSON.stringify({ jsonrpc: "2.0", method, params, id })
      this.proc.stdin!.write(msg + "\n")
    })
  }

  /** Send a JSON-RPC notification (no response expected) */
  notify(method: string, params?: Record<string, unknown>): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params })
    this.proc.stdin!.write(msg + "\n")
  }

  /** Subscribe to server notifications by method name */
  on(method: string, handler: (params: Record<string, unknown>) => void): void {
    const existing = this.listeners.get(method) ?? []
    existing.push(handler)
    this.listeners.set(method, existing)
  }

  /** Unsubscribe a specific handler */
  off(method: string, handler: (params: Record<string, unknown>) => void): void {
    const handlers = this.listeners.get(method) ?? []
    const idx = handlers.indexOf(handler)
    if (idx >= 0) handlers.splice(idx, 1)
  }

  /** Wait for a specific notification (returns first matching) */
  waitForNotification(
    method: string,
    predicate?: (params: Record<string, unknown>) => boolean
  ): Effect.Effect<Record<string, unknown>, Error> {
    return Effect.async<Record<string, unknown>, Error>((resume) => {
      let resolved = false

      const handler = (params: Record<string, unknown>) => {
        if (resolved) return
        if (!predicate || predicate(params)) {
          resolved = true
          // Remove this specific handler
          const handlers = this.listeners.get(method) ?? []
          const idx = handlers.indexOf(handler)
          if (idx >= 0) handlers.splice(idx, 1)
          resume(Effect.succeed(params))
        }
      }
      this.on(method, handler)
    })
  }

  shutdown(): void {
    this.rl.close()
    this.proc.kill()
  }
}

// ---------------------------------------------------------------------------
// Agent message from codex/event/agent_message notification
// ---------------------------------------------------------------------------
interface AgentMessageEvent {
  readonly msg: {
    readonly type: "agent_message"
    readonly message: string
    readonly phase?: string | null
  }
  readonly conversationId: string
}

// ---------------------------------------------------------------------------
// sendTurnAndWait — core operation: send a turn and wait for completion
//
// Protocol reality (discovered via live testing):
//   1. turn/start returns immediately with status "inProgress"
//   2. Agent messages stream via codex/event/agent_message notifications
//   3. turn/completed fires when done — but turn.items is EMPTY
//   4. So we collect agent_message texts during the turn, then return them
// ---------------------------------------------------------------------------
const sendTurnAndWait = (
  transport: CodexTransport,
  threadId: string,
  input: ReadonlyArray<UserInput>
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    // Accumulator for agent messages during this turn
    const collectedMessages: string[] = []

    // Start collecting agent messages BEFORE sending the turn
    const messageHandler = (params: Record<string, unknown>) => {
      const evt = params as unknown as AgentMessageEvent
      if (evt.conversationId === threadId && evt.msg?.message) {
        collectedMessages.push(evt.msg.message)
      }
    }
    transport.on("codex/event/agent_message", messageHandler)

    // Start the turn — pass multi-item input array directly
    const turnResponse = (yield* transport.call("turn/start", {
      threadId,
      input: input as UserInput[],
      approvalPolicy: "never" // Auto-approve for agent usage
    })) as { turn: Turn }

    const turnId = turnResponse.turn.id

    if (turnResponse.turn.status === "failed") {
      transport.off("codex/event/agent_message", messageHandler)
      return yield* Effect.fail(
        new Error(turnResponse.turn.error?.message ?? "Turn failed immediately")
      )
    }

    // If somehow completed synchronously
    if (turnResponse.turn.status === "completed") {
      transport.off("codex/event/agent_message", messageHandler)
      return collectedMessages.length > 0
        ? collectedMessages.join("\n")
        : `[Turn completed]`
    }

    // Wait for turn/completed notification (NOT codex/event/turn_completed)
    const notification = yield* transport.waitForNotification(
      "turn/completed",
      (params) => {
        const turn = params.turn as Turn | undefined
        return turn?.id === turnId
      }
    )

    // Clean up the message listener
    transport.off("codex/event/agent_message", messageHandler)

    const completedTurn = notification.turn as Turn

    if (completedTurn.status === "failed") {
      return yield* Effect.fail(
        new Error(completedTurn.error?.message ?? "Turn failed")
      )
    }

    // Return collected agent messages (turn.items is empty in the notification)
    if (collectedMessages.length > 0) {
      return collectedMessages.join("\n")
    }

    return `[Turn ${completedTurn.status}]`
  })

// ---------------------------------------------------------------------------
// Layer — spawns codex app-server and provides the service
// ---------------------------------------------------------------------------
export const CodexLLMLive: Layer.Layer<CodexLLM, Error> = Layer.effect(
  CodexLLM,
  Effect.gen(function* () {
    yield* Console.log("[codex] Spawning codex app-server on stdio...")

    // Spawn the Codex app server
    const proc = childProcess.spawn("npx", ["@openai/codex", "app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env }
    })

    const transport = new CodexTransport(proc)

    // Log agent messages for observability — full text, no truncation
    // The actual text comes via codex/event/agent_message (not item_completed)
    transport.on("codex/event/agent_message", (params) => {
      const evt = params as unknown as AgentMessageEvent
      if (evt.msg?.message) {
        const threadTag = evt.conversationId ? `[${evt.conversationId.slice(0, 8)}]` : ""
        const phase = evt.msg.phase ? ` (${evt.msg.phase})` : ""
        console.error(`\n\x1b[36m[codex:msg]${threadTag}${phase}\x1b[0m\n${evt.msg.message}\n`)
      }
    })

    // Log tool executions for observability — full output including patches
    transport.on("codex/event/item_completed", (params) => {
      const msg = params.msg as { type: string; item?: Record<string, unknown> } | undefined
      const item = msg?.item
      if (!item) return
      const itemType = (item.type as string)?.toLowerCase() ?? ""

      if (itemType === "commandexecution" || itemType === "command_execution") {
        const cmd = (item.command ?? item.input ?? "") as string
        console.error(`\n\x1b[33m[codex:tool]\x1b[0m $ ${cmd}`)
        // Show command output (stdout/stderr)
        const output = (item.output ?? item.aggregatedOutput ?? "") as string
        if (output) {
          console.error(`\x1b[90m${output}\x1b[0m`)
        }
      } else if (itemType === "filewrite" || itemType === "file_write" || itemType === "patch" || itemType === "fileedit" || itemType === "file_edit") {
        // Show file write / patch operations in full
        const path = (item.path ?? item.file ?? item.filePath ?? "") as string
        const content = (item.content ?? item.patch ?? item.diff ?? "") as string
        console.error(`\n\x1b[35m[codex:patch]\x1b[0m ${path}`)
        if (content) {
          console.error(`\x1b[90m${content}\x1b[0m`)
        }
      } else {
        // Log any other item types so nothing is hidden
        const summary = JSON.stringify(item, null, 2)
        if (summary.length > 10) {
          console.error(`\n\x1b[34m[codex:item:${itemType}]\x1b[0m\n\x1b[90m${summary}\x1b[0m`)
        }
      }
    })

    // Initialize handshake (v1)
    yield* Console.log("[codex] Sending initialize...")
    yield* transport.call("initialize", {
      clientInfo: {
        name: "ralph-effect",
        version: "1.0.0"
      }
    })

    // Send initialized notification
    transport.notify("initialized")
    yield* Console.log("[codex] Connected to Codex app-server")

    // Build service implementation
    const service: CodexLLMService = {
      generateText: (prompt) =>
        Effect.gen(function* () {
          // Create ephemeral thread
          const threadResult = (yield* transport.call("thread/start", {
            ephemeral: true,
            approvalPolicy: "never",
            sandbox: "workspace-write"
          })) as { thread: { id: string } }

          const threadId = threadResult.thread.id
          const text = yield* sendTurnAndWait(transport, threadId, [
            { type: "text", text: prompt }
          ])

          // Archive ephemeral thread
          yield* transport.call("thread/archive", { threadId }).pipe(
            Effect.catchAll(() => Effect.void)
          )

          return text
        }),

      createThread: (config) =>
        Effect.gen(function* () {
          // Build thread/start params from AgentConfig
          // Codex app-server uses Rust serde for deserialization:
          //   - sandbox: string ("workspace-write" | "read-only")
          //   - instructions: system-level prompt (not "personality")
          //   - model: model name string
          const params: Record<string, unknown> = {
            approvalPolicy: "never",
            sandbox: config?.sandbox ?? "workspace-write"
          }
          if (config?.personality) {
            params.instructions = config.personality
          }
          if (config?.model) {
            params.model = config.model
          }
          if (config?.reasoningEffort) {
            params.reasoningEffort = config.reasoningEffort
          }
          if (config?.writableRoots && config.writableRoots.length > 0) {
            params.writableRoots = config.writableRoots
          }
          const result = (yield* transport.call("thread/start", params)) as {
            thread: { id: string }
          }
          return result.thread.id
        }),

      sendTurn: (threadId, input) => {
        // Normalize: accept string (backward compat) or input array
        const items: ReadonlyArray<UserInput> =
          typeof input === "string"
            ? [{ type: "text", text: input }]
            : input
        return sendTurnAndWait(transport, threadId, items)
      },

      archiveThread: (threadId) =>
        Effect.gen(function* () {
          yield* transport.call("thread/archive", { threadId })
        }),

      shutdown: () =>
        Effect.sync(() => {
          transport.shutdown()
        })
    }

    return service
  })
)
