/**
 * orchestrator.ts — Ralph Loop Orchestrator.
 *
 * Manages N concurrent ralph loops as Effect Fibers.
 * Each loop gets a message Queue and observable SubscriptionRef.
 * PubSub broadcasts lifecycle events to subscribers (REPL, etc).
 *
 * Pipe system: wire one loop's output as another loop's input context.
 * Three strategies: context (structured injection), notify (lightweight signal),
 * file (write to disk + notify).
 *
 * Supports dependency ordering (forkAfter) and aggregation (reduce).
 *
 * Effect primitives: FiberMap, Queue, SubscriptionRef, PubSub.
 */
import { Context, Effect, FiberMap, Queue, SubscriptionRef, PubSub, Layer, Scope, Cause, Console } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { CodexLLM } from "./codex-client.js"
import { ralph } from "./ralph.js"
import type {
  LoopId,
  LoopConfig,
  LoopStatus,
  LoopState,
  LoopMessage,
  LoopEvent,
  ContextItem,
  PipeStrategy,
  PipeMetadata,
  PipeTransform
} from "./loop-types.js"
import { LoopEvent as LE, LoopMessage as LM } from "./loop-types.js"

// ---------------------------------------------------------------------------
// Pipe configuration
// ---------------------------------------------------------------------------
export type PipeTrigger = "iteration" | "done" | "both"

export interface PipeConfig {
  readonly from: LoopId
  readonly to: LoopId
  readonly on: PipeTrigger
  readonly strategy: PipeStrategy
  readonly transform?: PipeTransform
}

// ---------------------------------------------------------------------------
// Reduce configuration
// ---------------------------------------------------------------------------
export interface ReduceConfig {
  /** Sessions to collect Done results from */
  readonly sources: ReadonlyArray<LoopId>
  /** The reducing session config */
  readonly reducer: LoopConfig
  /** Optional transform to shape collected results before injecting */
  readonly transform?: (results: ReadonlyArray<{ id: LoopId; result: string }>) => string
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------
export interface OrchestratorService {
  /** Fork a new ralph loop. Returns the loop ID. */
  readonly fork: (config: LoopConfig) => Effect.Effect<LoopId, Error>

  /** Fork a loop that waits for specified loops to complete first */
  readonly forkAfter: (
    config: LoopConfig,
    waitFor: ReadonlyArray<LoopId>
  ) => Effect.Effect<LoopId, Error>

  /** Get current state of a specific loop */
  readonly status: (id: LoopId) => Effect.Effect<LoopState, Error>

  /** Get states of all loops */
  readonly statusAll: () => Effect.Effect<ReadonlyArray<LoopState>>

  /** Interrupt a running loop */
  readonly interrupt: (id: LoopId) => Effect.Effect<void, Error>

  /** Send a message to a loop's queue */
  readonly send: (id: LoopId, msg: LoopMessage) => Effect.Effect<void, Error>

  /**
   * Pipe one loop's output as context to another loop's input.
   * Strategy controls how data flows:
   *   - context: inject as structured ContextItem (default)
   *   - notify: lightweight one-line signal
   *   - file: write to disk, notify target of path
   */
  readonly pipe: (config: PipeConfig) => Effect.Effect<void, Error>

  /** Remove a pipe between two loops */
  readonly unpipe: (from: LoopId, to: LoopId) => Effect.Effect<void, Error>

  /** List all active pipes */
  readonly pipes: () => Effect.Effect<ReadonlyArray<PipeConfig>>

  /**
   * Reduce: collect Done results from N loops, fork a reducer with results as context.
   * Returns the reducer loop's ID.
   */
  readonly reduce: (config: ReduceConfig) => Effect.Effect<LoopId, Error>

  /** Subscribe to orchestrator-wide lifecycle events */
  readonly subscribe: () => Effect.Effect<Queue.Dequeue<LoopEvent>, never, Scope.Scope>

  /** Wait for all loops to complete */
  readonly awaitAll: () => Effect.Effect<void>
}

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------
export class Orchestrator extends Context.Tag("@ralph-effect/Orchestrator")<
  Orchestrator,
  OrchestratorService
>() {}

// ---------------------------------------------------------------------------
// Internal per-loop handle
// ---------------------------------------------------------------------------
interface LoopHandle {
  readonly queue: Queue.Queue<LoopMessage>
  readonly stateRef: SubscriptionRef.SubscriptionRef<LoopState>
}

// ---------------------------------------------------------------------------
// Apply a pipe: dispatch on strategy to move data between loops
// ---------------------------------------------------------------------------
const applyPipe = (
  pipeConfig: PipeConfig,
  sourceOutput: string,
  iteration: number,
  trigger: "iteration" | "done",
  deliverContext: (targetId: LoopId, item: ContextItem) => Effect.Effect<void>
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const metadata: PipeMetadata = {
      from: pipeConfig.from,
      to: pipeConfig.to,
      iteration,
      trigger,
      timestamp: Date.now()
    }

    const transformedText = pipeConfig.transform
      ? pipeConfig.transform(sourceOutput, metadata)
      : sourceOutput

    // Extract strategy for TS narrowing
    const strategy = pipeConfig.strategy

    switch (strategy._tag) {
      case "context": {
        const maxLen = strategy.maxLength ?? 4000
        yield* deliverContext(pipeConfig.to, {
          source: pipeConfig.from,
          timestamp: Date.now(),
          text: transformedText.slice(0, maxLen),
          tag: trigger
        })
        break
      }

      case "notify": {
        yield* deliverContext(pipeConfig.to, {
          source: pipeConfig.from,
          timestamp: Date.now(),
          text: `Loop "${pipeConfig.from}" completed ${trigger} (iteration ${iteration})`,
          tag: "notification"
        })
        break
      }

      case "file": {
        const filePath = strategy.path
        // Write output to shared file path
        yield* Effect.try({
          try: () => {
            const dir = path.dirname(filePath)
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(filePath, transformedText, "utf-8")
          },
          catch: (e) => new Error(`Pipe file write failed: ${e}`)
        }).pipe(Effect.catchAll((e) => Console.log(`[pipe:file] ${(e as Error).message}`)))

        // Notify target that file was updated
        yield* deliverContext(pipeConfig.to, {
          source: pipeConfig.from,
          timestamp: Date.now(),
          text: `Output from "${pipeConfig.from}" written to ${filePath}. Read it to get the latest data.`,
          tag: "file-update"
        })
        break
      }
    }
  })

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------
export const OrchestratorLive: Layer.Layer<Orchestrator, never, CodexLLM> = Layer.scoped(
  Orchestrator,
  Effect.gen(function* () {
    // Capture the CodexLLM service so we can provide it to forked fibers
    const codexService = yield* CodexLLM

    // FiberMap manages all loop fibers by name
    const fibers = yield* FiberMap.make<LoopId>()

    // Per-loop handles (queue + state ref)
    const handles = new Map<LoopId, LoopHandle>()

    // Global event bus
    const eventBus = yield* PubSub.unbounded<LoopEvent>()

    // Active pipes: keyed by "from->to"
    const activePipes = new Map<string, PipeConfig>()
    const pendingContexts = new Map<LoopId, ContextItem[]>()

    const deliverContext = (targetId: LoopId, item: ContextItem): Effect.Effect<void> =>
      Effect.gen(function* () {
        const targetHandle = handles.get(targetId)
        if (!targetHandle) {
          const queued = pendingContexts.get(targetId) ?? []
          pendingContexts.set(targetId, [...queued, item])
          return
        }
        yield* Queue.offer(targetHandle.queue, LM.InjectContext({ item }))
      })

    const createHandle = (config: LoopConfig, status: LoopStatus): Effect.Effect<LoopHandle, Error> =>
      Effect.gen(function* () {
        if (handles.has(config.id)) {
          return yield* Effect.fail(new Error(`Loop already exists: ${config.id}`))
        }

        const queue = yield* Queue.unbounded<LoopMessage>()
        const initialState: LoopState = {
          id: config.id,
          goal: config.goal,
          status,
          iteration: 0,
          maxIterations: config.maxIterations,
          lastAgentOutput: "",
          lastEvalResult: "",
          threadId: "",
          context: [],
          startedAt: Date.now(),
          updatedAt: Date.now()
        }
        const stateRef = yield* SubscriptionRef.make(initialState)
        const handle = { queue, stateRef }
        handles.set(config.id, handle)

        for (const item of pendingContexts.get(config.id) ?? []) {
          yield* Queue.offer(queue, LM.InjectContext({ item }))
        }
        pendingContexts.delete(config.id)

        return handle
      })

    const runManagedLoop = (
      config: LoopConfig,
      handle: LoopHandle
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* SubscriptionRef.update(handle.stateRef, (state) => ({
          ...state,
          goal: config.goal,
          maxIterations: config.maxIterations,
          status: "running" as const,
          updatedAt: Date.now()
        }))

        yield* PubSub.publish(eventBus, LE.Started({ id: config.id, goal: config.goal }))

        const result = yield* ralph(config, {
          queue: handle.queue,
          stateRef: handle.stateRef,
          eventBus
        }).pipe(Effect.provideService(CodexLLM, codexService))

        yield* PubSub.publish(
          eventBus,
          LE.Done({
            id: config.id,
            iterations: result.iterations,
            result: result.result.slice(0, 4000)
          })
        )
      }).pipe(
        Effect.tapErrorCause((cause) => {
          if (Cause.isInterruptedOnly(cause)) {
            return Effect.gen(function* () {
              yield* SubscriptionRef.update(handle.stateRef, (state) => ({
                ...state,
                status: "interrupted" as const,
                updatedAt: Date.now()
              }))
              yield* PubSub.publish(eventBus, LE.Interrupted({ id: config.id }))
            })
          }

          const errMsg = Cause.pretty(cause).slice(0, 500)
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(handle.stateRef, (state) => ({
              ...state,
              status: "failed" as const,
              updatedAt: Date.now()
            }))
            yield* PubSub.publish(eventBus, LE.Failed({ id: config.id, error: errMsg }))
          })
        }),
        Effect.catchAllCause(() => Effect.void)
      )

    const waitForOutcomes = (
      ids: ReadonlyArray<LoopId>
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        if (ids.length === 0) {
          return
        }

        const sub = yield* PubSub.subscribe(eventBus)
        const remaining = new Set(ids)

        for (const id of ids) {
          const handle = handles.get(id)
          if (!handle) {
            continue
          }
          const state = yield* SubscriptionRef.get(handle.stateRef)
          if (
            state.status === "done" ||
            state.status === "failed" ||
            state.status === "interrupted"
          ) {
            remaining.delete(id)
          }
        }

        while (remaining.size > 0) {
          const event = yield* Queue.take(sub)
          if (
            (event._tag === "Done" || event._tag === "Failed" || event._tag === "Interrupted") &&
            remaining.has(event.id)
          ) {
            remaining.delete(event.id)
          }
        }
      })

    const collectReduceResults = (
      sources: ReadonlyArray<LoopId>
    ): Effect.Effect<Array<{ id: LoopId; result: string }>, never, Scope.Scope> =>
      Effect.gen(function* () {
        const sub = yield* PubSub.subscribe(eventBus)
        const remaining = new Set(sources)
        const results: Array<{ id: LoopId; result: string }> = []

        for (const sourceId of sources) {
          const handle = handles.get(sourceId)
          if (!handle) {
            continue
          }
          const state = yield* SubscriptionRef.get(handle.stateRef)
          if (state.status === "done") {
            remaining.delete(sourceId)
            results.push({ id: sourceId, result: state.lastAgentOutput })
            continue
          }
          if (state.status === "failed" || state.status === "interrupted") {
            remaining.delete(sourceId)
          }
        }

        while (remaining.size > 0) {
          const event = yield* Queue.take(sub)
          if (event._tag === "Done" && remaining.has(event.id)) {
            remaining.delete(event.id)
            results.push({ id: event.id, result: event.result })
          }
          if (
            (event._tag === "Failed" || event._tag === "Interrupted") &&
            remaining.has(event.id)
          ) {
            remaining.delete(event.id)
          }
        }

        return results
      })

    // -----------------------------------------------------------------------
    // Routing fiber: subscribes to events and applies pipe rules
    // Dispatches on pipe strategy (context, notify, file)
    // -----------------------------------------------------------------------
    const routerSub = yield* PubSub.subscribe(eventBus)
    yield* Effect.fork(
      Effect.forever(
        Effect.gen(function* () {
          const event = yield* Queue.take(routerSub)

          // Check pipes that match this event's source
          for (const [, pipeConfig] of activePipes) {
            if (event._tag === "IterationComplete" && event.id === pipeConfig.from) {
              if (pipeConfig.on === "iteration" || pipeConfig.on === "both") {
                const sourceHandle = handles.get(pipeConfig.from)
                if (sourceHandle) {
                  const sourceState = yield* SubscriptionRef.get(sourceHandle.stateRef)
                  yield* applyPipe(
                    pipeConfig,
                    sourceState.lastAgentOutput,
                    event.iteration,
                    "iteration",
                    deliverContext
                  )
                }
              }
            }

            if (event._tag === "Done" && event.id === pipeConfig.from) {
              if (pipeConfig.on === "done" || pipeConfig.on === "both") {
                yield* applyPipe(
                  pipeConfig,
                  event.result,
                  event.iterations,
                  "done",
                  deliverContext
                )
              }
            }
          }
        })
      )
    )

    const service: OrchestratorService = {
      fork: (config) =>
        Effect.gen(function* () {
          const handle = yield* createHandle(config, "running")
          yield* FiberMap.run(fibers, config.id, runManagedLoop(config, handle))
          return config.id
        }),

      forkAfter: (config, waitFor) =>
        Effect.gen(function* () {
          const handle = yield* createHandle(config, waitFor.length > 0 ? "waiting" : "running")
          const loopEffect = Effect.scoped(
            Effect.gen(function* () {
              yield* waitForOutcomes(waitFor)
              yield* runManagedLoop(config, handle)
            })
          )
          yield* FiberMap.run(fibers, config.id, loopEffect)
          return config.id
        }),

      status: (id) =>
        Effect.gen(function* () {
          const handle = handles.get(id)
          if (!handle) return yield* Effect.fail(new Error(`Loop not found: ${id}`))
          return yield* SubscriptionRef.get(handle.stateRef)
        }),

      statusAll: () =>
        Effect.gen(function* () {
          const states: LoopState[] = []
          for (const [, handle] of handles) {
            states.push(yield* SubscriptionRef.get(handle.stateRef))
          }
          return states
        }),

      interrupt: (id) =>
        Effect.gen(function* () {
          const exists = yield* FiberMap.has(fibers, id)
          if (!exists) return yield* Effect.fail(new Error(`Loop not found or already completed: ${id}`))
          yield* FiberMap.remove(fibers, id) // interrupts the fiber
        }),

      send: (id, msg) =>
        Effect.gen(function* () {
          const handle = handles.get(id)
          if (!handle) return yield* Effect.fail(new Error(`Loop not found: ${id}`))
          yield* Queue.offer(handle.queue, msg)
        }),

      pipe: (config) =>
        Effect.gen(function* () {
          if (config.from === config.to) {
            return yield* Effect.fail(new Error(`Cannot pipe a loop to itself`))
          }

          const key = `${config.from}->${config.to}`
          activePipes.set(key, config)

          const sourceHandle = handles.get(config.from)
          if (!sourceHandle) {
            return
          }

          const sourceState = yield* SubscriptionRef.get(sourceHandle.stateRef)
          if (
            sourceState.status === "done" &&
            (config.on === "done" || config.on === "both")
          ) {
            yield* applyPipe(
              config,
              sourceState.lastAgentOutput,
              sourceState.iteration,
              "done",
              deliverContext
            )
          }
        }),

      unpipe: (from, to) =>
        Effect.gen(function* () {
          const key = `${from}->${to}`
          if (!activePipes.has(key)) {
            return yield* Effect.fail(new Error(`No pipe found: ${from} -> ${to}`))
          }
          activePipes.delete(key)
        }),

      pipes: () =>
        Effect.succeed(Array.from(activePipes.values())),

      reduce: (config) =>
        Effect.gen(function* () {
          const handle = yield* createHandle(config.reducer, "waiting")
          const reducerEffect = Effect.scoped(
            Effect.gen(function* () {
              const results = yield* collectReduceResults(config.sources)

              if (config.transform) {
                yield* deliverContext(config.reducer.id, {
                  source: "system",
                  timestamp: Date.now(),
                  text: config.transform(results).slice(0, 4000),
                  tag: "reduce-input"
                })
              } else {
                for (const result of results) {
                  yield* deliverContext(config.reducer.id, {
                    source: result.id,
                    timestamp: Date.now(),
                    text: result.result.slice(0, 4000),
                    tag: "reduce-input"
                  })
                }
              }

              yield* runManagedLoop(config.reducer, handle)
            })
          )

          yield* FiberMap.run(fibers, config.reducer.id, reducerEffect)
          return config.reducer.id
        }),

      subscribe: () => PubSub.subscribe(eventBus),

      awaitAll: () => FiberMap.join(fibers).pipe(Effect.catchAll(() => Effect.void))
    }

    return service
  })
)
