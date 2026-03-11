/**
 * codex-client.ts — Uses Codex as an execution backend via JSON-RPC.
 *
 * This is the other half of Option C: when our ralph loop encounters
 * a coding task, it can delegate to a Codex instance for sandboxed
 * execution. The product USES Codex AND IS a Codex server.
 *
 * Transport: stdio (spawn codex process) or WebSocket.
 */
import { Effect, Console } from "effect"
import * as childProcess from "node:child_process"
import * as readline from "node:readline"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface JsonRpcRequest {
  jsonrpc: "2.0"
  method: string
  params?: Record<string, unknown>
  id: number
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | null
  result?: unknown
  error?: { code: number; message: string }
}

// ---------------------------------------------------------------------------
// Codex client — spawns a codex process and talks JSON-RPC over stdio
// ---------------------------------------------------------------------------
export class CodexClient {
  private process: childProcess.ChildProcess | null = null
  private rl: readline.Interface | null = null
  private requestId = 0
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()

  /**
   * Connect to a Codex instance.
   * Spawns `codex --app-server` as a child process.
   */
  connect = Effect.gen(this, function* () {
    yield* Console.log("[codex-client] Spawning codex app server...")

    this.process = childProcess.spawn("codex", ["--app-server"], {
      stdio: ["pipe", "pipe", "pipe"]
    })

    this.rl = readline.createInterface({ input: this.process.stdout! })

    this.rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as JsonRpcResponse
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          if (msg.error) {
            reject(new Error(msg.error.message))
          } else {
            resolve(msg.result)
          }
        }
        // Notifications (no id) — log them for ralph supervision
        if (msg.id == null) {
          const notification = msg as any
          if (notification.method) {
            console.error(
              `[codex] ${notification.method}: ${JSON.stringify(notification.params)}`
            )
          }
        }
      } catch {
        // ignore parse errors on notifications
      }
    })

    // Initialize handshake
    yield* this.call("initialize", {
      clientInfo: {
        name: "ralph-effect",
        title: "Ralph Effect Agent",
        version: "1.0.0"
      }
    })

    this.send({ jsonrpc: "2.0", method: "initialized", id: 0 } as any)
    yield* Console.log("[codex-client] Connected to Codex")
  })

  /**
   * Send a JSON-RPC request and await the response.
   */
  call = (method: string, params?: Record<string, unknown>) =>
    Effect.async<unknown, Error>((resume) => {
      const id = ++this.requestId
      const req: JsonRpcRequest = { jsonrpc: "2.0", method, params, id }

      this.pending.set(id, {
        resolve: (v) => resume(Effect.succeed(v)),
        reject: (e) => resume(Effect.fail(e))
      })

      this.send(req)

      // Timeout after 60s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          resume(Effect.fail(new Error(`Timeout waiting for ${method}`)))
        }
      }, 60000)
    })

  /**
   * Start a thread and run a goal through Codex.
   * This is how the ralph loop delegates to Codex.
   */
  runGoal = (goal: string) =>
    Effect.gen(this, function* () {
      const threadResult = yield* this.call("thread/start", {})
      const threadId = (threadResult as any).threadId

      const turnResult = yield* this.call("turn/start", {
        threadId,
        prompt: goal
      })

      return turnResult
    })

  /**
   * Disconnect from Codex.
   */
  disconnect = Effect.sync(() => {
    this.rl?.close()
    this.process?.kill()
    this.process = null
  })

  private send(req: JsonRpcRequest) {
    this.process?.stdin?.write(JSON.stringify(req) + "\n")
  }
}

export const codexClient = new CodexClient()
