/**
 * loop-types.ts — Shared types for the ralph orchestrator.
 *
 * Vocabulary: LoopState, LoopMessage, LoopEvent, LoopConfig.
 * Zero logic, zero dependencies beyond `effect`.
 */
import { Data, Effect } from "effect"

// ---------------------------------------------------------------------------
// Loop identity
// ---------------------------------------------------------------------------
export type LoopId = string

// ---------------------------------------------------------------------------
// Loop status
// ---------------------------------------------------------------------------
export type LoopStatus = "waiting" | "running" | "paused" | "done" | "failed" | "interrupted"

// ---------------------------------------------------------------------------
// Context item — structured injected context with provenance
// ---------------------------------------------------------------------------
export interface ContextItem {
  readonly source: LoopId | "user" | "system"
  readonly timestamp: number
  readonly text: string
  /** Optional semantic label, e.g., "critique", "code-review", "notification" */
  readonly tag?: string
}

// ---------------------------------------------------------------------------
// Agent config — identity & sandbox, set at thread creation
// ---------------------------------------------------------------------------
export interface AgentConfig {
  /** Codex personality parameter — system-level persona */
  readonly personality?: string
  /** Codex sandbox mode */
  readonly sandbox?: "read-only" | "workspace-write"
  /** Paths the agent can write to (Codex sandbox.writableRoots) */
  readonly writableRoots?: string[]
  /** Optional model override */
  readonly model?: string
  /** Reasoning effort level for reasoning models */
  readonly reasoningEffort?: "low" | "medium" | "high"
}

// ---------------------------------------------------------------------------
// Evaluation result — returned by evaluators
// ---------------------------------------------------------------------------
export interface EvalResult {
  readonly done: boolean
  readonly reason: string
}

// ---------------------------------------------------------------------------
// Custom evaluator function signature
// ---------------------------------------------------------------------------
export type Evaluator = (
  goal: string,
  agentOutput: string
) => Effect.Effect<EvalResult, Error>

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
  readonly threadId: string
  /** Sliding window of injected context items */
  readonly context: ReadonlyArray<ContextItem>
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
  /** Inject structured context from another loop (used by pipe()) */
  InjectContext: { readonly item: ContextItem }
  /** Clear all injected context */
  ClearContext: {}
}>

export const LoopMessage = Data.taggedEnum<LoopMessage>()

// ---------------------------------------------------------------------------
// Pipe strategy — how data flows between loops
// ---------------------------------------------------------------------------
export type PipeStrategy =
  | { readonly _tag: "context"; readonly maxLength?: number }
  | { readonly _tag: "notify" }
  | { readonly _tag: "file"; readonly path: string }

// ---------------------------------------------------------------------------
// Pipe metadata — available to transform functions
// ---------------------------------------------------------------------------
export interface PipeMetadata {
  readonly from: LoopId
  readonly to: LoopId
  readonly iteration: number
  readonly trigger: "iteration" | "done"
  readonly timestamp: number
}

// ---------------------------------------------------------------------------
// Pipe transform — shapes data as it flows through a pipe
// ---------------------------------------------------------------------------
export type PipeTransform = (text: string, metadata: PipeMetadata) => string

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
  /** Agent identity & sandbox config (set on thread creation) */
  readonly agent?: AgentConfig
  /** Max context items in sliding window (default: 5) */
  readonly maxContextItems?: number
  /** Custom evaluator — overrides default LLM-as-judge */
  readonly evaluator?: Evaluator
}
