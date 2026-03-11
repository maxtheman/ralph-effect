/**
 * loop-types.ts — Shared types for the ralph orchestrator.
 *
 * Vocabulary: LoopState, LoopMessage, LoopEvent, LoopConfig.
 * Zero logic, zero dependencies beyond `effect`.
 */
import { Data } from "effect"

// ---------------------------------------------------------------------------
// Loop identity
// ---------------------------------------------------------------------------
export type LoopId = string

// ---------------------------------------------------------------------------
// Loop status
// ---------------------------------------------------------------------------
export type LoopStatus = "running" | "paused" | "done" | "failed" | "interrupted"

// ---------------------------------------------------------------------------
// Loop state — stored in SubscriptionRef, queried by orchestrator
// ---------------------------------------------------------------------------
export interface LoopState {
  readonly id: LoopId
  readonly goal: string
  readonly status: LoopStatus
  readonly iteration: number
  readonly maxIterations: number
  readonly lastAgentOutput: string
  readonly lastEvalResult: string
  readonly startedAt: number
  readonly updatedAt: number
}

// ---------------------------------------------------------------------------
// Messages injected into a running loop's Queue
// ---------------------------------------------------------------------------
export type LoopMessage = Data.TaggedEnum<{
  /** Append user instruction to current goal */
  UserMessage: { readonly text: string }
  /** Replace the current goal entirely */
  SetGoal: { readonly goal: string }
  /** Pause after current iteration completes */
  Pause: {}
  /** Resume a paused loop */
  Resume: {}
  /** Adjust max iterations at runtime */
  SetMaxIterations: { readonly max: number }
}>

export const LoopMessage = Data.taggedEnum<LoopMessage>()

// ---------------------------------------------------------------------------
// Events broadcast via PubSub (for REPL / observers)
// ---------------------------------------------------------------------------
export type LoopEvent = Data.TaggedEnum<{
  Started: { readonly id: LoopId; readonly goal: string }
  IterationComplete: {
    readonly id: LoopId
    readonly iteration: number
    readonly evalResult: string
  }
  Done: { readonly id: LoopId; readonly iterations: number; readonly result: string }
  Failed: { readonly id: LoopId; readonly error: string }
  Interrupted: { readonly id: LoopId }
}>

export const LoopEvent = Data.taggedEnum<LoopEvent>()

// ---------------------------------------------------------------------------
// Extended loop config
// ---------------------------------------------------------------------------
export interface LoopConfig {
  readonly id: LoopId
  readonly goal: string
  readonly maxIterations: number
  readonly verbose: boolean
}
