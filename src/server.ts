/**
 * server.ts — Dashboard backend exposing the orchestrator over HTTP + SSE.
 */
import { Effect, Layer, ManagedRuntime, Queue } from "effect"
import * as fs from "node:fs"
import * as http from "node:http"
import * as path from "node:path"
import { CodexLLMLive } from "./codex-client.js"
import { runWorkflow } from "./dsl/index.js"
import type { OrchestratorService, PipeConfig, PipeTrigger } from "./orchestrator.js"
import { Orchestrator, OrchestratorLive } from "./orchestrator.js"
import { LoopMessage as LM } from "./loop-types.js"
import type { LoopEvent, LoopState, PipeStrategy } from "./loop-types.js"
import { extractJsonRenderSpecReport } from "./ui-spec-validator.js"
import type {
  ForkRequest,
  GoalRequest,
  JsonRenderSpec,
  JsonRenderSpecDiagnostic,
  MaxIterationsRequest,
  PipeRequest,
  SendRequest,
  StatusEventPayload,
  UIEmitRequest,
  UIUpdateEventPayload,
  WorkflowRequest
} from "./ui-types.js"

const DEFAULT_PORT = 3741
const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_HEARTBEAT_MS = 10_000
const DEFAULT_BODY_LIMIT_BYTES = 1_000_000
const DEFAULT_VITE_DEV_HOST = "127.0.0.1"
const DEFAULT_VITE_DEV_PORT = 5173

interface DashboardServerOptions {
  readonly host?: string
  readonly port?: number
  readonly corsOrigin?: string
  readonly statusHeartbeatMs?: number
  readonly frontendDistDir?: string
  readonly viteDevHost?: string
  readonly viteDevPort?: number
}

interface DashboardServer {
  readonly host: string
  readonly port: number
  readonly uiSpecs: ReadonlyMap<string, JsonRenderSpec>
  readonly listen: () => Promise<void>
  readonly close: () => Promise<void>
  readonly runWorkflow: (filePath: string) => Promise<void>
}

interface SSEClient {
  readonly id: number
  readonly response: http.ServerResponse
}

class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const createPipeStrategy = (request: PipeRequest): PipeStrategy => {
  switch (request.strategy) {
    case "context":
      return request.maxLength && request.maxLength > 0
        ? { _tag: "context", maxLength: request.maxLength }
        : { _tag: "context" }
    case "notify":
      return { _tag: "notify" }
    case "file":
      if (!request.path) {
        throw new HttpError(400, "Pipe strategy \"file\" requires a path")
      }
      return { _tag: "file", path: request.path }
    default:
      throw new HttpError(400, `Unsupported pipe strategy: ${String(request.strategy)}`)
  }
}

const validatePipeTrigger = (value: unknown): PipeTrigger => {
  if (value === "iteration" || value === "done" || value === "both") {
    return value
  }
  throw new HttpError(400, "Pipe trigger must be one of: iteration, done, both")
}

const validateString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, `${field} must be a non-empty string`)
  }
  return value
}

const validatePositiveInteger = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, `${field} must be a positive integer`)
  }
  return value
}

const writeSSE = (
  response: http.ServerResponse,
  event: string,
  payload: unknown
): void => {
  response.write(`event: ${event}\n`)
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

const setCorsHeaders = (
  response: http.ServerResponse,
  origin: string
): void => {
  response.setHeader("Access-Control-Allow-Origin", origin)
  response.setHeader("Access-Control-Allow-Headers", "Content-Type")
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
}

const writeJson = (
  response: http.ServerResponse,
  status: number,
  payload: unknown,
  origin: string
): void => {
  setCorsHeaders(response, origin)
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  response.end(JSON.stringify(payload))
}

const writeError = (
  response: http.ServerResponse,
  error: unknown,
  origin: string
): void => {
  const status = error instanceof HttpError
    ? error.status
    : error instanceof Error && /not found/i.test(error.message)
      ? 404
      : 500
  const message = error instanceof Error ? error.message : "Unknown server error"
  writeJson(response, status, { error: message }, origin)
}

const readRequestBody = async (request: http.IncomingMessage): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0

    request.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > DEFAULT_BODY_LIMIT_BYTES) {
        reject(new HttpError(413, "Request body too large"))
        request.destroy()
        return
      }
      chunks.push(buffer)
    })

    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })

const readJsonBody = async <T>(request: http.IncomingMessage): Promise<T> => {
  const raw = await readRequestBody(request)
  if (raw.trim().length === 0) {
    return {} as T
  }

  try {
    return JSON.parse(raw) as T
  } catch {
    throw new HttpError(400, "Request body must be valid JSON")
  }
}

const uiEventToMessage = (body: UIEmitRequest): string => {
  const event = validateString(body.event, "event")
  const lines = [`[Dashboard UI Event] ${event}`]
  if (body.payload && Object.keys(body.payload).length > 0) {
    lines.push(JSON.stringify(body.payload, null, 2))
  }
  return lines.join("\n")
}

const mimeTypeForPath = (filePath: string): string => {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8"
    case ".css":
      return "text/css; charset=utf-8"
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8"
    case ".json":
      return "application/json; charset=utf-8"
    case ".svg":
      return "image/svg+xml"
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".ico":
      return "image/x-icon"
    case ".map":
      return "application/json; charset=utf-8"
    default:
      return "text/plain; charset=utf-8"
  }
}

const createPlaceholderHtml = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Ralph Dashboard Backend</title>
  </head>
  <body>
    <main>
      <h1>Ralph Dashboard Backend</h1>
      <p>The backend is running, but the frontend bundle is not present yet.</p>
    </main>
  </body>
</html>`

export const createDashboardServer = async (
  options: DashboardServerOptions = {}
): Promise<DashboardServer> => {
  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT
  const corsOrigin = options.corsOrigin ?? "*"
  const statusHeartbeatMs = options.statusHeartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const viteDevHost = options.viteDevHost ?? DEFAULT_VITE_DEV_HOST
  const viteDevPort = options.viteDevPort ?? DEFAULT_VITE_DEV_PORT
  const frontendDistDir = path.resolve(
    options.frontendDistDir ?? path.join(process.cwd(), "frontend", "dist")
  )
  const uiSpecs = new Map<string, JsonRenderSpec>()
  const uiDiagnostics = new Map<string, JsonRenderSpecDiagnostic>()
  const sseClients = new Map<number, SSEClient>()
  let nextClientId = 1

  const runtime = ManagedRuntime.make(Layer.provide(OrchestratorLive, CodexLLMLive))

  const runWithOrchestrator = async <A, E>(
    effectFactory: (orch: OrchestratorService) => Effect.Effect<A, E>
  ): Promise<A> =>
    await runtime.runPromise(
      Effect.gen(function* () {
        const orch = yield* Orchestrator
        return yield* effectFactory(orch)
      })
    )

  const broadcast = (event: string, payload: unknown): void => {
    for (const [id, client] of sseClients) {
      if (client.response.destroyed || client.response.writableEnded) {
        sseClients.delete(id)
        continue
      }
      try {
        writeSSE(client.response, event, payload)
      } catch {
        sseClients.delete(id)
      }
    }
  }

  const broadcastStatus = async (): Promise<void> => {
    if (sseClients.size === 0) {
      return
    }
    const loops = await runWithOrchestrator((orch) => orch.statusAll())
    const payload: StatusEventPayload = { loops }
    broadcast("status", payload)
  }

  const storeUISpec = (id: string, spec: JsonRenderSpec): void => {
    uiSpecs.set(id, spec)
    const payload: UIUpdateEventPayload = { id, spec }
    broadcast("UIUpdate", payload)
  }

  const maybeStoreUISpecFromOutput = (id: string, output: string): void => {
    const report = extractJsonRenderSpecReport(output)
    if (report.diagnostic.markerCount === 0) {
      return
    }

    uiDiagnostics.set(id, report.diagnostic)
    if (report.spec) {
      storeUISpec(id, report.spec)
    }
  }

  runtime.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const orch = yield* Orchestrator
        const subscription = yield* orch.subscribe()

        while (true) {
          const event = yield* Queue.take(subscription)
          broadcast(event._tag, event)

          if (event._tag === "IterationComplete") {
            const state = yield* orch.status(event.id).pipe(Effect.catchAll(() => Effect.succeed<LoopState | null>(null)))
            if (state?.lastAgentOutput) {
              maybeStoreUISpecFromOutput(event.id, state.lastAgentOutput)
            }
          }

          if (event._tag === "Done" && event.result) {
            maybeStoreUISpecFromOutput(event.id, event.result)
          }
        }
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            console.error("[dashboard] event subscription failed")
            console.error(String(cause))
          })
        )
      )
    )
  )

  const heartbeat = setInterval(() => {
    void broadcastStatus().catch((error) => {
      console.error("[dashboard] heartbeat failed", error)
    })
  }, statusHeartbeatMs)

  const serveFrontend = async (
    request: http.IncomingMessage,
    pathname: string,
    response: http.ServerResponse
  ): Promise<void> => {
    if (process.env.NODE_ENV !== "production") {
      await new Promise<void>((resolve, reject) => {
        const proxied = http.request(
          {
            host: viteDevHost,
            port: viteDevPort,
            method: request.method,
            path: request.url,
            headers: request.headers
          },
          (viteResponse) => {
            response.writeHead(viteResponse.statusCode ?? 502, viteResponse.headers)
            viteResponse.pipe(response)
            viteResponse.on("end", resolve)
          }
        )

        proxied.on("error", reject)
        request.pipe(proxied)
      }).catch(async () => {
        const indexPath = path.join(frontendDistDir, "index.html")
        if (fs.existsSync(indexPath)) {
          await serveFrontendFromDist(pathname, response)
          return
        }
        response.writeHead(502, { "Content-Type": "text/html; charset=utf-8" })
        response.end(createPlaceholderHtml())
      })
      return
    }

    await serveFrontendFromDist(pathname, response)
  }

  const serveFrontendFromDist = async (
    pathname: string,
    response: http.ServerResponse
  ): Promise<void> => {
    const indexPath = path.join(frontendDistDir, "index.html")
    if (!fs.existsSync(indexPath)) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      response.end(createPlaceholderHtml())
      return
    }

    const requested = pathname === "/"
      ? indexPath
      : path.resolve(frontendDistDir, `.${pathname}`)
    const safePath = requested.startsWith(frontendDistDir) ? requested : indexPath
    const filePath = fs.existsSync(safePath) && fs.statSync(safePath).isFile()
      ? safePath
      : indexPath

    response.writeHead(200, { "Content-Type": mimeTypeForPath(filePath) })
    response.end(fs.readFileSync(filePath))
  }

  const requestListener = async (
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`)
    const pathname = url.pathname
    const method = request.method ?? "GET"

    try {
      if (pathname === "/events") {
        setCorsHeaders(response, corsOrigin)

        if (method === "OPTIONS") {
          response.writeHead(204)
          response.end()
          return
        }

        if (method !== "GET") {
          throw new HttpError(405, "Method not allowed")
        }

        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no"
        })
        response.flushHeaders?.()

        const clientId = nextClientId++
        sseClients.set(clientId, { id: clientId, response })

        writeSSE(response, "status", {
          loops: await runWithOrchestrator((orch) => orch.statusAll())
        } satisfies StatusEventPayload)
        for (const [id, spec] of uiSpecs) {
          writeSSE(response, "UIUpdate", { id, spec } satisfies UIUpdateEventPayload)
        }

        request.on("close", () => {
          sseClients.delete(clientId)
        })
        return
      }

      if (pathname.startsWith("/api/")) {
        setCorsHeaders(response, corsOrigin)
      }

      if (method === "OPTIONS" && pathname.startsWith("/api/")) {
        response.writeHead(204)
        response.end()
        return
      }

      if (pathname === "/api/status" && method === "GET") {
        writeJson(response, 200, await runWithOrchestrator((orch) => orch.statusAll()), corsOrigin)
        return
      }

      const statusMatch = pathname.match(/^\/api\/status\/([^/]+)$/)
      if (statusMatch && method === "GET") {
        const id = decodeURIComponent(statusMatch[1] ?? "")
        writeJson(response, 200, await runWithOrchestrator((orch) => orch.status(id)), corsOrigin)
        return
      }

      if (pathname === "/api/pipes" && method === "GET") {
        writeJson(response, 200, await runWithOrchestrator((orch) => orch.pipes()), corsOrigin)
        return
      }

      const uiEmitMatch = pathname.match(/^\/api\/ui\/([^/]+)\/emit$/)
      if (uiEmitMatch && method === "POST") {
        const id = decodeURIComponent(uiEmitMatch[1] ?? "")
        const body = await readJsonBody<UIEmitRequest>(request)
        await runWithOrchestrator((orch) => orch.send(id, LM.UserMessage({ text: uiEventToMessage(body) })))
        writeJson(response, 200, { ok: true }, corsOrigin)
        return
      }

      const uiDiagnosticMatch = pathname.match(/^\/api\/ui\/([^/]+)\/diagnostics$/)
      if (uiDiagnosticMatch && method === "GET") {
        const id = decodeURIComponent(uiDiagnosticMatch[1] ?? "")
        writeJson(response, 200, uiDiagnostics.get(id) ?? null, corsOrigin)
        return
      }

      const uiMatch = pathname.match(/^\/api\/ui\/([^/]+)$/)
      if (uiMatch && method === "GET") {
        const id = decodeURIComponent(uiMatch[1] ?? "")
        writeJson(response, 200, uiSpecs.get(id) ?? null, corsOrigin)
        return
      }

      if (pathname === "/api/fork" && method === "POST") {
        const body = await readJsonBody<ForkRequest>(request)
        const id = validateString(body.id, "id")
        const goal = validateString(body.goal, "goal")
        const maxIterations = body.maxIterations === undefined
          ? 10
          : validatePositiveInteger(body.maxIterations, "maxIterations")

        await runWithOrchestrator((orch) =>
          orch.fork({
            id,
            goal,
            maxIterations,
            verbose: false,
            agent: body.agent
          })
        )

        writeJson(response, 200, { id }, corsOrigin)
        return
      }

      const pauseMatch = pathname.match(/^\/api\/([^/]+)\/pause$/)
      if (pauseMatch && method === "POST") {
        const id = decodeURIComponent(pauseMatch[1] ?? "")
        await runWithOrchestrator((orch) => orch.send(id, LM.Pause()))
        writeJson(response, 200, { ok: true }, corsOrigin)
        return
      }

      const resumeMatch = pathname.match(/^\/api\/([^/]+)\/resume$/)
      if (resumeMatch && method === "POST") {
        const id = decodeURIComponent(resumeMatch[1] ?? "")
        await runWithOrchestrator((orch) => orch.send(id, LM.Resume()))
        writeJson(response, 200, { ok: true }, corsOrigin)
        return
      }

      const interruptMatch = pathname.match(/^\/api\/([^/]+)\/interrupt$/)
      if (interruptMatch && method === "POST") {
        const id = decodeURIComponent(interruptMatch[1] ?? "")
        await runWithOrchestrator((orch) => orch.interrupt(id))
        writeJson(response, 200, { ok: true }, corsOrigin)
        return
      }

      const sendMatch = pathname.match(/^\/api\/([^/]+)\/send$/)
      if (sendMatch && method === "POST") {
        const id = decodeURIComponent(sendMatch[1] ?? "")
        const body = await readJsonBody<SendRequest>(request)
        await runWithOrchestrator((orch) =>
          orch.send(id, LM.UserMessage({ text: validateString(body.text, "text") }))
        )
        writeJson(response, 200, { ok: true }, corsOrigin)
        return
      }

      const goalMatch = pathname.match(/^\/api\/([^/]+)\/goal$/)
      if (goalMatch && method === "POST") {
        const id = decodeURIComponent(goalMatch[1] ?? "")
        const body = await readJsonBody<GoalRequest>(request)
        await runWithOrchestrator((orch) =>
          orch.send(id, LM.SetGoal({ goal: validateString(body.goal, "goal") }))
        )
        writeJson(response, 200, { ok: true }, corsOrigin)
        return
      }

      const maxIterMatch = pathname.match(/^\/api\/([^/]+)\/maxiter$/)
      if (maxIterMatch && method === "POST") {
        const id = decodeURIComponent(maxIterMatch[1] ?? "")
        const body = await readJsonBody<MaxIterationsRequest>(request)
        await runWithOrchestrator((orch) =>
          orch.send(id, LM.SetMaxIterations({ max: validatePositiveInteger(body.max, "max") }))
        )
        writeJson(response, 200, { ok: true }, corsOrigin)
        return
      }

      if (pathname === "/api/pipe" && method === "POST") {
        const body = await readJsonBody<PipeRequest>(request)
        const from = validateString(body.from, "from")
        const to = validateString(body.to, "to")
        const on = validatePipeTrigger(body.on)

        await runWithOrchestrator((orch) =>
          orch.pipe({
            from,
            to,
            on,
            strategy: createPipeStrategy(body)
          })
        )

        writeJson(response, 200, { ok: true }, corsOrigin)
        return
      }

      if (pathname === "/api/unpipe" && method === "POST") {
        const body = await readJsonBody<{ from: string; to: string }>(request)
        await runWithOrchestrator((orch) =>
          orch.unpipe(
            validateString(body.from, "from"),
            validateString(body.to, "to")
          )
        )
        writeJson(response, 200, { ok: true }, corsOrigin)
        return
      }

      if (pathname === "/api/workflow" && method === "POST") {
        const body = await readJsonBody<WorkflowRequest>(request)
        const filePath = validateString(body.path, "path")
        await runtime.runPromise(runWorkflow(filePath))
        writeJson(response, 200, { ok: true }, corsOrigin)
        return
      }

      if (pathname.startsWith("/api/")) {
        throw new HttpError(404, `Unknown API route: ${method} ${pathname}`)
      }

      await serveFrontend(request, pathname, response)
    } catch (error) {
      writeError(response, error, corsOrigin)
    }
  }

  const server = http.createServer((request, response) => {
    void requestListener(request, response)
  })

  return {
    host,
    port,
    uiSpecs,
    listen: async () => {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, () => {
          server.off("error", reject)
          resolve()
        })
      })
    },
    close: async () => {
      clearInterval(heartbeat)

      for (const [, client] of sseClients) {
        client.response.end()
      }
      sseClients.clear()

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })

      await runtime.dispose()
    },
    runWorkflow: async (filePath: string) => {
      await runtime.runPromise(runWorkflow(filePath))
    }
  }
}

export type { DashboardServer, DashboardServerOptions, DashboardServer as RalphDashboardServer, DashboardServerOptions as RalphDashboardServerOptions, PipeConfig }
