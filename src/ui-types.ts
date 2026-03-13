/**
 * ui-types.ts — Shared dashboard API and agent UI types.
 */
import type { LoopEvent, LoopState, PipeStrategy } from "./loop-types.js"

/** JSON UI tree emitted by an agent for dashboard rendering. */
export interface JsonRenderSpec {
  readonly root: string
  readonly elements: Record<string, JsonRenderElement>
}

/** Individual UI element referenced by a JsonRenderSpec. */
export interface JsonRenderElement {
  readonly component: string
  readonly props: Record<string, unknown>
  readonly children?: ReadonlyArray<string>
}

/** Request body for creating a new loop. */
export interface ForkRequest {
  readonly id: string
  readonly goal: string
  readonly maxIterations?: number
  readonly agent?: {
    readonly personality?: string
    readonly sandbox?: "read-only" | "workspace-write"
    readonly model?: string
    readonly reasoningEffort?: "low" | "medium" | "high"
  }
}

/** Pipe trigger supported by the dashboard API. */
export type PipeTriggerRequest = "iteration" | "done" | "both"

/** Request body for adding a pipe between two loops. */
export interface PipeRequest {
  readonly from: string
  readonly to: string
  readonly on: PipeTriggerRequest
  readonly strategy: PipeStrategy["_tag"]
  readonly path?: string
  readonly maxLength?: number
}

/** Request body for UI-originated events sent back to an agent. */
export interface UIEmitRequest {
  readonly event: string
  readonly payload?: Record<string, unknown>
}

/** Request body for loading and running a workflow file. */
export interface WorkflowRequest {
  readonly path: string
}

/** Request body for sending freeform user text to a loop. */
export interface SendRequest {
  readonly text: string
}

/** Request body for replacing a loop goal. */
export interface GoalRequest {
  readonly goal: string
}

/** Request body for changing max iterations on a loop. */
export interface MaxIterationsRequest {
  readonly max: number
}

/** Common shape for routes that only report success. */
export interface OkResponse {
  readonly ok: true
}

/** Payload sent for SSE heartbeat updates. */
export interface StatusEventPayload {
  readonly loops: ReadonlyArray<LoopState>
}

/** Payload sent when a loop's UI spec changes. */
export interface UIUpdateEventPayload {
  readonly id: string
  readonly spec: JsonRenderSpec
}

/** Structured diagnostics for the latest agent-emitted UI payload. */
export interface JsonRenderSpecDiagnostic {
  readonly ok: boolean
  readonly error?: string
  readonly markerCount: number
  readonly updatedAt: number
}

/** Union of SSE payloads emitted by the dashboard backend. */
export type DashboardEvent =
  | LoopEvent
  | ({ readonly _tag: "status" } & StatusEventPayload)
  | ({ readonly _tag: "UIUpdate" } & UIUpdateEventPayload)
