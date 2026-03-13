/**
 * dashboard-types.ts — Frontend-local mirrors of the dashboard wire types.
 *
 * The root package is currently CommonJS, so importing `src/*.ts` directly into
 * the frontend's ESM typecheck causes module-mode conflicts. These interfaces
 * intentionally mirror the backend wire shapes until the packages are unified.
 */
export type LoopId = string

export type LoopStatus =
  | "waiting"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "interrupted"

export interface ContextItem {
  readonly source: LoopId | "user" | "system"
  readonly timestamp: number
  readonly text: string
  readonly tag?: string
}

export interface AgentConfig {
  readonly personality?: string
  readonly sandbox?: "read-only" | "workspace-write"
  readonly writableRoots?: string[]
  readonly model?: string
  readonly reasoningEffort?: "low" | "medium" | "high"
}

export interface LoopState {
  readonly id: LoopId
  readonly goal: string
  readonly status: LoopStatus
  readonly iteration: number
  readonly maxIterations: number
  readonly lastAgentOutput: string
  readonly lastEvalResult: string
  readonly threadId: string
  readonly context: ReadonlyArray<ContextItem>
  readonly startedAt: number
  readonly updatedAt: number
}

export type PipeStrategy =
  | { readonly _tag: "context"; readonly maxLength?: number }
  | { readonly _tag: "notify" }
  | { readonly _tag: "file"; readonly path: string }

export type LoopEvent =
  | { readonly _tag: "Started"; readonly id: LoopId; readonly goal: string }
  | {
      readonly _tag: "IterationComplete"
      readonly id: LoopId
      readonly iteration: number
      readonly evalResult: string
    }
  | { readonly _tag: "Done"; readonly id: LoopId; readonly iterations: number; readonly result: string }
  | { readonly _tag: "Failed"; readonly id: LoopId; readonly error: string }
  | { readonly _tag: "Interrupted"; readonly id: LoopId }

export interface JsonRenderSpec {
  readonly root: string
  readonly elements: Record<string, JsonRenderElement>
}

export interface JsonRenderElement {
  readonly component: string
  readonly props: Record<string, unknown>
  readonly children?: ReadonlyArray<string>
}

export interface ForkRequest {
  readonly id: string
  readonly goal: string
  readonly maxIterations?: number
  readonly agent?: AgentConfig
}

export interface PipeRequest {
  readonly from: string
  readonly to: string
  readonly on: "iteration" | "done" | "both"
  readonly strategy: PipeStrategy["_tag"]
  readonly path?: string
  readonly maxLength?: number
}

export interface UIEmitRequest {
  readonly event: string
  readonly payload?: Record<string, unknown>
}

export interface WorkflowRequest {
  readonly path: string
}

export interface GoalRequest {
  readonly goal: string
}

export interface SendRequest {
  readonly text: string
}

export interface MaxIterationsRequest {
  readonly max: number
}

export interface StatusEventPayload {
  readonly loops: ReadonlyArray<LoopState>
}

export interface UIUpdateEventPayload {
  readonly id: string
  readonly spec: JsonRenderSpec
}

export type DashboardEvent =
  | LoopEvent
  | ({ readonly _tag: "status" } & StatusEventPayload)
  | ({ readonly _tag: "UIUpdate" } & UIUpdateEventPayload)
