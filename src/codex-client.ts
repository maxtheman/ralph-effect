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
 *   - codex/event/turn_completed notification signals the turn is done
 */
import { Context, Effect, Layer, Console } from "effect"
import * as childProcess from "node:child_process"
import * as readline from "node:readline"

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
  /** Create a persistent thread (for multi-turn conversations) */
  readonly createThread: () => Effect.Effect<string, Error>
  /** Send a turn to an existing thread, wait for completion */
  readonly sendTurn: (threadId: string, prompt: string) => Effect.Effect<string, Error>
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

      // Timeout after 5 minutes (Codex agent turns can be long)
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          resume(Effect.fail(new Error(`Timeout waiting for ${method} (id=${id})`)))
        }
      }, 300000)
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

  /** Wait for a specific notification (returns first matching) */
  waitForNotification(
    method: string,
    predicate?: (params: Record<string, unknown>) => boolean,
    timeoutMs = 300000
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

      setTimeout(() => {
        if (!resolved) {
          resolved = true
          const handlers = this.listeners.get(method) ?? []
          const idx = handlers.indexOf(handler)
          if (idx >= 0) handlers.splice(idx, 1)
          resume(Effect.fail(new Error(`Timeout waiting for notification: ${method}`)))
        }
      }, timeoutMs)
    })
  }

  shutdown(): void {
    this.rl.close()
    this.proc.kill()
  }
}

// ---------------------------------------------------------------------------
// Extract agent text from turn items
// ---------------------------------------------------------------------------
const extractAgentText = (turn: Turn): string => {
  const messages = turn.items
    .filter((item) => item.type === "agentMessage" && item.text)
    .map((item) => item.text!)

  if (messages.length > 0) return messages.join("\n")

  // Fallback: check for any text in items
  const anyText = turn.items
    .filter((item) => item.text)
    .map((item) => item.text!)

  if (anyText.length > 0) return anyText.join("\n")

  return `[Turn ${turn.status}${turn.error ? `: ${turn.error.message}` : ""}]`
}

// ---------------------------------------------------------------------------
// sendTurnAndWait — core operation: send a turn and wait for completion
// ---------------------------------------------------------------------------
const sendTurnAndWait = (
  transport: CodexTransport,
  threadId: string,
  prompt: string
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    // Start the turn
    const turnResponse = (yield* transport.call("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }] satisfies UserInput[],
      approvalPolicy: "never" // Auto-approve for agent usage
    })) as { turn: Turn }

    const turnId = turnResponse.turn.id

    // If the turn completed synchronously (unlikely but possible)
    if (turnResponse.turn.status === "completed") {
      return extractAgentText(turnResponse.turn)
    }

    if (turnResponse.turn.status === "failed") {
      return yield* Effect.fail(
        new Error(turnResponse.turn.error?.message ?? "Turn failed immediately")
      )
    }

    // Wait for turn_completed notification
    const notification = yield* transport.waitForNotification(
      "codex/event/turn_completed",
      (params) => {
        const turn = params.turn as Turn | undefined
        return turn?.id === turnId
      }
    )

    const completedTurn = notification.turn as Turn

    if (completedTurn.status === "failed") {
      return yield* Effect.fail(
        new Error(completedTurn.error?.message ?? "Turn failed")
      )
    }

    return extractAgentText(completedTurn)
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

    // Log item completed notifications for observability
    transport.on("codex/event/item_completed", (params) => {
      const item = params.item as ThreadItem | undefined
      if (item?.type === "commandExecution") {
        console.error(`[codex:tool] ${item.command}`)
      } else if (item?.type === "agentMessage") {
        const preview = (item.text ?? "").slice(0, 80)
        console.error(`[codex:msg] ${preview}${(item.text?.length ?? 0) > 80 ? "..." : ""}`)
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
          const text = yield* sendTurnAndWait(transport, threadId, prompt)

          // Archive ephemeral thread
          yield* transport.call("thread/archive", { threadId }).pipe(
            Effect.catchAll(() => Effect.void)
          )

          return text
        }),

      createThread: () =>
        Effect.gen(function* () {
          const result = (yield* transport.call("thread/start", {
            approvalPolicy: "never",
            sandbox: "workspace-write"
          })) as { thread: { id: string } }
          return result.thread.id
        }),

      sendTurn: (threadId, prompt) => sendTurnAndWait(transport, threadId, prompt),

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
