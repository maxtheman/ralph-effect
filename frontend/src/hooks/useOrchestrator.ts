/**
 * useOrchestrator.ts — Dashboard state controller and JSX hook facade.
 */
import {
  startTransition,
  useEffect,
  useMemo,
  useState
} from "../lib/mini-react.js"
import type {
  DashboardEvent,
  ForkRequest,
  GoalRequest,
  JsonRenderSpec,
  LoopEvent,
  LoopState,
  MaxIterationsRequest,
  PipeStrategy,
  PipeRequest,
  SendRequest,
  UIEmitRequest,
  WorkflowRequest
} from "../shared/dashboard-types.js"

export interface DashboardPipe {
  readonly from: string
  readonly to: string
  readonly on: "iteration" | "done" | "both"
  readonly strategy: PipeStrategy
}

export interface DashboardEventRecord {
  readonly payload: DashboardEvent
  readonly receivedAt: number
}

export interface OrchestratorSnapshot {
  readonly loops: ReadonlyArray<LoopState>
  readonly pipes: ReadonlyArray<DashboardPipe>
  readonly events: ReadonlyArray<DashboardEventRecord>
  readonly agentUIs: ReadonlyMap<string, JsonRenderSpec>
  readonly uiErrors: ReadonlyMap<string, string>
  readonly connected: boolean
  readonly selectedLoopId: string | null
  readonly error: string | null
}

export interface OrchestratorActions {
  readonly fork: (request: ForkRequest) => Promise<void>
  readonly pause: (id: string) => Promise<void>
  readonly resume: (id: string) => Promise<void>
  readonly interrupt: (id: string) => Promise<void>
  readonly send: (id: string, text: string) => Promise<void>
  readonly setGoal: (id: string, goal: string) => Promise<void>
  readonly setMaxIterations: (id: string, max: number) => Promise<void>
  readonly addPipe: (request: PipeRequest) => Promise<void>
  readonly removePipe: (from: string, to: string) => Promise<void>
  readonly loadWorkflow: (request: WorkflowRequest) => Promise<void>
  readonly emitUIEvent: (
    id: string,
    event: string,
    payload?: Record<string, unknown>
  ) => Promise<void>
  readonly selectLoop: (id: string | null) => void
}

export type OrchestratorModel = OrchestratorSnapshot & OrchestratorActions

type Listener = (snapshot: OrchestratorSnapshot) => void

const createSnapshot = (): OrchestratorSnapshot => ({
  loops: [],
  pipes: [],
  events: [],
  agentUIs: new Map<string, JsonRenderSpec>(),
  uiErrors: new Map<string, string>(),
  connected: false,
  selectedLoopId: null,
  error: null
})

export class OrchestratorController {
  private snapshot = createSnapshot()
  private readonly listeners = new Set<Listener>()
  private eventSource: EventSource | null = null
  private pollTimer: number | null = null
  private started = false

  getSnapshot(): OrchestratorSnapshot {
    return this.snapshot
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => {
      this.listeners.delete(listener)
    }
  }

  start(): void {
    if (this.started) return
    this.started = true
    void this.refreshAll()
    this.connectEvents()
    this.pollTimer = window.setInterval(() => {
      void this.refreshAll()
    }, 5_000)
  }

  stop(): void {
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.started = false
  }

  async fork(request: ForkRequest): Promise<void> {
    await this.postJson<{ id: string }>("/api/fork", request)
    await this.refreshAll()
  }

  async pause(id: string): Promise<void> {
    await this.postJson<{ ok: true }>(`/api/${encodeURIComponent(id)}/pause`)
    await this.refreshStatus()
  }

  async resume(id: string): Promise<void> {
    await this.postJson<{ ok: true }>(`/api/${encodeURIComponent(id)}/resume`)
    await this.refreshStatus()
  }

  async interrupt(id: string): Promise<void> {
    await this.postJson<{ ok: true }>(`/api/${encodeURIComponent(id)}/interrupt`)
    await this.refreshStatus()
  }

  async send(id: string, text: string): Promise<void> {
    const body: SendRequest = { text }
    await this.postJson<{ ok: true }>(`/api/${encodeURIComponent(id)}/send`, body)
    await this.refreshStatus()
  }

  async setGoal(id: string, goal: string): Promise<void> {
    const body: GoalRequest = { goal }
    await this.postJson<{ ok: true }>(`/api/${encodeURIComponent(id)}/goal`, body)
    await this.refreshStatus()
  }

  async setMaxIterations(id: string, max: number): Promise<void> {
    const body: MaxIterationsRequest = { max }
    await this.postJson<{ ok: true }>(`/api/${encodeURIComponent(id)}/maxiter`, body)
    await this.refreshStatus()
  }

  async addPipe(request: PipeRequest): Promise<void> {
    await this.postJson<{ ok: true }>("/api/pipe", request)
    await this.refreshPipes()
  }

  async removePipe(from: string, to: string): Promise<void> {
    await this.postJson<{ ok: true }>("/api/unpipe", { from, to })
    await this.refreshPipes()
  }

  async loadWorkflow(request: WorkflowRequest): Promise<void> {
    await this.postJson<{ ok: true }>("/api/workflow", request)
    await this.refreshAll()
  }

  async emitUIEvent(
    id: string,
    event: string,
    payload?: Record<string, unknown>
  ): Promise<void> {
    const body: UIEmitRequest = { event, payload }
    await this.postJson<{ ok: true }>(`/api/ui/${encodeURIComponent(id)}/emit`, body)
  }

  selectLoop(id: string | null): void {
    this.patch({ selectedLoopId: id })
  }

  private pushEvent(payload: DashboardEvent | LoopEvent): void {
    this.patch({
      events: [...this.snapshot.events, { payload, receivedAt: Date.now() }].slice(-160)
    })
  }

  private patch(partial: Partial<OrchestratorSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...partial
    }
    for (const listener of this.listeners) {
      listener(this.snapshot)
    }
  }

  private async refreshAll(): Promise<void> {
    await Promise.allSettled([this.refreshStatus(), this.refreshPipes()])
  }

  private async refreshStatus(): Promise<void> {
    try {
      const payload = await this.getJson<unknown>("/api/status")
      const loops = Array.isArray(payload)
        ? payload
            .map((item) => normalizeLoopState(item))
            .filter((item): item is LoopState => item !== null)
        : []

      this.patch({
        loops,
        error: null,
        selectedLoopId: chooseSelectedLoop(this.snapshot.selectedLoopId, loops)
      })

      await this.refreshAgentUIs(loops.map((loop) => loop.id))
    } catch (error) {
      this.patch({
        error: describeError(error),
        connected: false
      })
    }
  }

  private async refreshPipes(): Promise<void> {
    try {
      const payload = await this.getJson<unknown>("/api/pipes")
      const pipes = Array.isArray(payload)
        ? payload
            .map((item) => normalizePipe(item))
            .filter((item): item is DashboardPipe => item !== null)
        : []
      this.patch({ pipes })
    } catch (error) {
      this.patch({ error: describeError(error) })
    }
  }

  private async refreshAgentUIs(loopIds: ReadonlyArray<string>): Promise<void> {
    const next = new Map(this.snapshot.agentUIs)
    const nextErrors = new Map(this.snapshot.uiErrors)
    await Promise.all(
      loopIds.map(async (id) => {
        try {
          const payload = await this.getJson<unknown>(`/api/ui/${encodeURIComponent(id)}`)
          if (payload === null) {
            next.delete(id)
            nextErrors.delete(id)
            return
          }
          const spec = normalizeJsonRenderSpec(payload)
          if (spec) {
            next.set(id, spec)
            nextErrors.delete(id)
          } else {
            next.delete(id)
            nextErrors.set(id, "Invalid UI spec returned by the dashboard API.")
          }
        } catch (error) {
          next.delete(id)
          nextErrors.set(id, describeError(error))
        }
      })
    )
    for (const loopId of [...nextErrors.keys()]) {
      if (!loopIds.includes(loopId)) {
        nextErrors.delete(loopId)
      }
    }
    this.patch({ agentUIs: next, uiErrors: nextErrors })
  }

  private connectEvents(): void {
    if (this.eventSource || typeof EventSource === "undefined") return

    const source = new EventSource("/events")
    this.eventSource = source

    const eventTypes = [
      "Started",
      "IterationComplete",
      "Done",
      "Failed",
      "Interrupted",
      "UIUpdate",
      "status"
    ] as const

    for (const eventType of eventTypes) {
      source.addEventListener(eventType, (event) => {
        const rawData = "data" in event && typeof event.data === "string" ? event.data : ""
        if (eventType === "UIUpdate") {
          const uiUpdate = parseUIUpdateEvent(rawData)
          if (uiUpdate?.kind === "valid") {
            void this.applyEvent(uiUpdate.event)
            return
          }
          if (uiUpdate?.kind === "invalid") {
            const next = new Map(this.snapshot.agentUIs)
            const nextErrors = new Map(this.snapshot.uiErrors)
            next.delete(uiUpdate.id)
            nextErrors.set(uiUpdate.id, uiUpdate.error)
            this.patch({ agentUIs: next, uiErrors: nextErrors, connected: true })
          }
          return
        }

        const payload = parseDashboardEvent(eventType, rawData)
        if (payload) {
          void this.applyEvent(payload)
        }
      })
    }

    source.onopen = () => {
      this.patch({ connected: true, error: null })
      void this.refreshAll()
    }

    source.onerror = () => {
      this.patch({
        connected: false,
        error: this.snapshot.error ?? "Waiting for dashboard backend on /events."
      })
    }

    source.onmessage = (event) => {
      const payload = parseDashboardEvent("message", event.data)
      if (payload) {
        void this.applyEvent(payload)
      }
    }
  }

  private async applyEvent(payload: DashboardEvent): Promise<void> {
    switch (payload._tag) {
      case "status":
        this.patch({
          connected: true,
          loops: payload.loops,
          selectedLoopId: chooseSelectedLoop(this.snapshot.selectedLoopId, payload.loops),
          error: null
        })
        return
      case "UIUpdate": {
        const next = new Map(this.snapshot.agentUIs)
        const nextErrors = new Map(this.snapshot.uiErrors)
        next.set(payload.id, payload.spec)
        nextErrors.delete(payload.id)
        this.patch({ agentUIs: next, uiErrors: nextErrors, connected: true, error: null })
        this.pushEvent(payload)
        return
      }
      default:
        this.pushEvent(payload)
        this.patch({ connected: true, error: null })
        await this.refreshStatus()
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(path, {
      headers: { Accept: "application/json" }
    })
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`)
    }
    return (await response.json()) as T
  }

  private async postJson<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`)
    }
    if (response.status === 204) {
      return undefined as T
    }
    return (await response.json()) as T
  }
}

const controller = new OrchestratorController()

export const useOrchestrator = (): OrchestratorModel => {
  const [snapshot, setSnapshot] = useState<OrchestratorSnapshot>(controller.getSnapshot())

  useEffect(() => {
    const unsubscribe = controller.subscribe((next) => {
      startTransition(() => {
        setSnapshot(next)
      })
    })
    controller.start()
    return () => {
      unsubscribe()
      controller.stop()
    }
  }, [])

  const actions = useMemo<OrchestratorActions>(
    () => ({
      fork: (request) => controller.fork(request),
      pause: (id) => controller.pause(id),
      resume: (id) => controller.resume(id),
      interrupt: (id) => controller.interrupt(id),
      send: (id, text) => controller.send(id, text),
      setGoal: (id, goal) => controller.setGoal(id, goal),
      setMaxIterations: (id, max) => controller.setMaxIterations(id, max),
      addPipe: (request) => controller.addPipe(request),
      removePipe: (from, to) => controller.removePipe(from, to),
      loadWorkflow: (request) => controller.loadWorkflow(request),
      emitUIEvent: (id, event, payload) => controller.emitUIEvent(id, event, payload),
      selectLoop: (id) => controller.selectLoop(id)
    }),
    []
  )

  return {
    ...snapshot,
    ...actions
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const chooseSelectedLoop = (
  current: string | null,
  loops: ReadonlyArray<LoopState>
): string | null => {
  if (current && loops.some((loop) => loop.id === current)) return current
  return loops[0]?.id ?? null
}

const normalizeLoopState = (value: unknown): LoopState | null => {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.goal !== "string") return null
  return {
    id: value.id,
    goal: value.goal,
    status: isLoopStatus(value.status) ? value.status : "waiting",
    iteration: typeof value.iteration === "number" ? value.iteration : 0,
    maxIterations: typeof value.maxIterations === "number" ? value.maxIterations : 1,
    lastAgentOutput: typeof value.lastAgentOutput === "string" ? value.lastAgentOutput : "",
    lastEvalResult: typeof value.lastEvalResult === "string" ? value.lastEvalResult : "",
    threadId: typeof value.threadId === "string" ? value.threadId : "",
    context: Array.isArray(value.context)
      ? value.context.filter((item): item is LoopState["context"][number] => isContextItem(item))
      : [],
    startedAt: typeof value.startedAt === "number" ? value.startedAt : Date.now(),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now()
  }
}

const isLoopStatus = (value: unknown): value is LoopState["status"] =>
  value === "waiting" ||
  value === "running" ||
  value === "paused" ||
  value === "done" ||
  value === "failed" ||
  value === "interrupted"

const isContextItem = (value: unknown): value is LoopState["context"][number] =>
  isRecord(value) &&
  typeof value.source === "string" &&
  typeof value.timestamp === "number" &&
  typeof value.text === "string"

const normalizePipe = (value: unknown): DashboardPipe | null => {
  if (!isRecord(value) || typeof value.from !== "string" || typeof value.to !== "string") return null
  const strategy = normalizePipeStrategy(value.strategy)
  if (!strategy) return null
  const on = value.on
  if (on !== "iteration" && on !== "done" && on !== "both") return null
  return {
    from: value.from,
    to: value.to,
    on,
    strategy
  }
}

const normalizePipeStrategy = (value: unknown): PipeStrategy | null => {
  if (typeof value === "string") {
    switch (value) {
      case "context":
        return { _tag: "context" }
      case "notify":
        return { _tag: "notify" }
      case "file":
        return { _tag: "file", path: "" }
      default:
        return null
    }
  }

  if (!isRecord(value) || typeof value._tag !== "string") return null
  switch (value._tag) {
    case "context":
      return {
        _tag: "context",
        maxLength: typeof value.maxLength === "number" ? value.maxLength : undefined
      }
    case "notify":
      return { _tag: "notify" }
    case "file":
      return {
        _tag: "file",
        path: typeof value.path === "string" ? value.path : ""
      }
    default:
      return null
  }
}

const normalizeJsonRenderSpec = (value: unknown): JsonRenderSpec | null => {
  if (!isRecord(value) || typeof value.root !== "string" || !isRecord(value.elements)) return null
  const elements: JsonRenderSpec["elements"] = {}
  for (const [id, elementValue] of Object.entries(value.elements)) {
    if (
      !isRecord(elementValue) ||
      typeof elementValue.component !== "string" ||
      !isRecord(elementValue.props)
    ) {
      return null
    }
    elements[id] = {
      component: elementValue.component,
      props: { ...elementValue.props },
      children:
        Array.isArray(elementValue.children) &&
        elementValue.children.every((child) => typeof child === "string")
          ? [...elementValue.children]
          : undefined
    }
  }
  return {
    root: value.root,
    elements
  }
}

const parseDashboardEvent = (eventType: string, rawData: string): DashboardEvent | null => {
  if (!rawData) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(rawData)
  } catch {
    return null
  }

  const tag = eventType === "message" ? undefined : eventType

  if (tag === "status") {
    const loops = Array.isArray(parsed)
      ? parsed
          .map((item) => normalizeLoopState(item))
          .filter((item): item is LoopState => item !== null)
      : isRecord(parsed) && Array.isArray(parsed.loops)
        ? parsed.loops
            .map((item) => normalizeLoopState(item))
            .filter((item): item is LoopState => item !== null)
        : []
    return { _tag: "status", loops }
  }

  if (tag === "UIUpdate") {
    const uiUpdate = parseUIUpdatePayload(parsed)
    return uiUpdate?.kind === "valid" ? uiUpdate.event : null
  }

  if (isRecord(parsed) && typeof parsed._tag === "string") {
    const normalized = normalizeLoopEvent(parsed)
    if (normalized) return normalized
  }

  if (tag) {
    const normalized = normalizeLoopEvent({ _tag: tag, ...(isRecord(parsed) ? parsed : {}) })
    if (normalized) return normalized
  }

  return null
}

const parseUIUpdateEvent = (
  rawData: string
):
  | { readonly kind: "valid"; readonly event: Extract<DashboardEvent, { readonly _tag: "UIUpdate" }> }
  | { readonly kind: "invalid"; readonly id: string; readonly error: string }
  | null => {
  if (!rawData) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(rawData)
  } catch {
    return null
  }

  return parseUIUpdatePayload(parsed)
}

const parseUIUpdatePayload = (
  parsed: unknown
):
  | { readonly kind: "valid"; readonly event: Extract<DashboardEvent, { readonly _tag: "UIUpdate" }> }
  | { readonly kind: "invalid"; readonly id: string; readonly error: string }
  | null => {
  if (!isRecord(parsed) || typeof parsed.id !== "string") {
    return null
  }

  const spec = normalizeJsonRenderSpec(parsed.spec)
  if (spec) {
    return { kind: "valid", event: { _tag: "UIUpdate", id: parsed.id, spec } }
  }

  return {
    kind: "invalid",
    id: parsed.id,
    error: "Agent emitted an invalid UI spec."
  }
}

const normalizeLoopEvent = (value: unknown): LoopEvent | null => {
  if (!isRecord(value) || typeof value._tag !== "string") return null
  switch (value._tag) {
    case "Started":
      return typeof value.id === "string" && typeof value.goal === "string"
        ? { _tag: "Started", id: value.id, goal: value.goal }
        : null
    case "IterationComplete":
      return typeof value.id === "string" &&
        typeof value.iteration === "number" &&
        typeof value.evalResult === "string"
        ? {
            _tag: "IterationComplete",
            id: value.id,
            iteration: value.iteration,
            evalResult: value.evalResult
          }
        : null
    case "Done":
      return typeof value.id === "string" &&
        typeof value.iterations === "number" &&
        typeof value.result === "string"
        ? {
            _tag: "Done",
            id: value.id,
            iterations: value.iterations,
            result: value.result
          }
        : null
    case "Failed":
      return typeof value.id === "string" && typeof value.error === "string"
        ? { _tag: "Failed", id: value.id, error: value.error }
        : null
    case "Interrupted":
      return typeof value.id === "string" ? { _tag: "Interrupted", id: value.id } : null
    default:
      return null
  }
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown dashboard error"
