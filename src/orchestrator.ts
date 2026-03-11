/**
 * orchestrator.ts — Ralph Loop Orchestrator.
 *
 * Manages N concurrent ralph loops as Effect Fibers.
 * Each loop gets a message Queue and observable SubscriptionRef.
 * PubSub broadcasts lifecycle events to subscribers (REPL, etc).
 *
 * Effect primitives: FiberMap, Queue, SubscriptionRef, PubSub.
 */
import { Context, Effect, FiberMap, Queue, SubscriptionRef, PubSub, Layer, Scope, Cause } from "effect"
import { CodexLLM } from "./codex-client.js"
import { ralph } from "./ralph.js"
import type { LoopId, LoopConfig, LoopState, LoopMessage, LoopEvent } from "./loop-types.js"
import { LoopEvent as LE } from "./loop-types.js"

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------
export interface OrchestratorService {
  /** Fork a new ralph loop. Returns the loop ID. */
  readonly fork: (config: LoopConfig) => Effect.Effect<LoopId>

  /** Get current state of a specific loop */
  readonly status: (id: LoopId) => Effect.Effect<LoopState, Error>

  /** Get states of all loops */
  readonly statusAll: () => Effect.Effect<ReadonlyArray<LoopState>>

  /** Interrupt a running loop */
  readonly interrupt: (id: LoopId) => Effect.Effect<void, Error>

  /** Send a message to a loop's queue */
  readonly send: (id: LoopId, msg: LoopMessage) => Effect.Effect<void, Error>

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

    const service: OrchestratorService = {
      fork: (config) =>
        Effect.gen(function* () {
          // Create per-loop queue and state ref
          const queue = yield* Queue.unbounded<LoopMessage>()
          const initialState: LoopState = {
            id: config.id,
            goal: config.goal,
            status: "running",
            iteration: 0,
            maxIterations: config.maxIterations,
            lastAgentOutput: "",
            lastEvalResult: "",
            startedAt: Date.now(),
            updatedAt: Date.now()
          }
          const stateRef = yield* SubscriptionRef.make(initialState)

          handles.set(config.id, { queue, stateRef })

          // The effect to run inside the fiber (provide CodexLLM so it's self-contained)
          const loopEffect = ralph(config, { queue, stateRef }).pipe(
            Effect.provideService(CodexLLM, codexService),
            Effect.tap((result) =>
              PubSub.publish(
                eventBus,
                LE.Done({
                  id: config.id,
                  iterations: result.iterations,
                  result: result.result.slice(0, 200)
                })
              )
            ),
            Effect.tapErrorCause((cause) => {
              if (Cause.isInterruptedOnly(cause)) {
                return Effect.gen(function* () {
                  yield* SubscriptionRef.update(stateRef, (s) => ({
                    ...s,
                    status: "interrupted" as const,
                    updatedAt: Date.now()
                  }))
                  yield* PubSub.publish(eventBus, LE.Interrupted({ id: config.id }))
                })
              }
              const errMsg = Cause.pretty(cause).slice(0, 200)
              return Effect.gen(function* () {
                yield* SubscriptionRef.update(stateRef, (s) => ({
                  ...s,
                  status: "failed" as const,
                  updatedAt: Date.now()
                }))
                yield* PubSub.publish(eventBus, LE.Failed({ id: config.id, error: errMsg }))
              })
            }),
            Effect.catchAllCause(() => Effect.void)
          )

          // Fork into the FiberMap
          yield* FiberMap.run(fibers, config.id, loopEffect)

          yield* PubSub.publish(
            eventBus,
            LE.Started({ id: config.id, goal: config.goal })
          )

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

      subscribe: () => PubSub.subscribe(eventBus),

      awaitAll: () => FiberMap.join(fibers).pipe(Effect.catchAll(() => Effect.void))
    }

    return service
  })
)
