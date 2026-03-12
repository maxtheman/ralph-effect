/**
 * ast.ts — OpenProse AST node types for the Ralph workflow compiler.
 *
 * The `.prose` language syntax and semantics are defined by the OpenProse
 * specification: https://github.com/openprose/prose (MIT license).
 * This file implements AST types for a subset of that specification.
 */
import type { PipeStrategy } from "../loop-types.js"

// ---------------------------------------------------------------------------
// Source location
// ---------------------------------------------------------------------------
export interface Loc {
  readonly line: number
}

// ---------------------------------------------------------------------------
// Top-level program
// ---------------------------------------------------------------------------
export interface Program extends Loc {
  readonly _tag: "Program"
  readonly declarations: ReadonlyArray<Declaration>
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------
export type Declaration =
  | AgentDecl
  | LetDecl
  | SessionBlock
  | ParallelBlock
  | LoopUntilBlock
  | PipelineBlock
  | PipeDecl
  | IfBlock
  | MapExpr
  | ReduceExpr
  | TryBlock

// ---------------------------------------------------------------------------
// Agent declaration
// ---------------------------------------------------------------------------
export interface AgentDecl extends Loc {
  readonly _tag: "AgentDecl"
  readonly name: string
  readonly model?: string
  readonly reasoningEffort?: "low" | "medium" | "high"
  readonly prompt?: string
  readonly sandbox?: "read-only" | "workspace-write"
  readonly writableRoots?: ReadonlyArray<string>
}

// ---------------------------------------------------------------------------
// Variable binding
// ---------------------------------------------------------------------------
export interface LetDecl extends Loc {
  readonly _tag: "LetDecl"
  readonly name: string
  readonly value: string
  readonly constant: boolean
}

// ---------------------------------------------------------------------------
// Session block
// ---------------------------------------------------------------------------
export interface SessionBlock extends Loc {
  readonly _tag: "SessionBlock"
  readonly varName?: string
  readonly agent: string
  readonly goal: string
  readonly max?: number
  readonly dependsOn?: ReadonlyArray<string>
  readonly evaluate?: EvaluateAnnotation
}

// ---------------------------------------------------------------------------
// Evaluate annotation
// ---------------------------------------------------------------------------
export type EvaluateAnnotation =
  | { readonly _tag: "self" }
  | { readonly _tag: "agent"; readonly agentName: string }
  | {
      readonly _tag: "check"
      readonly checkName: string
      readonly args?: Record<string, string>
    }

// ---------------------------------------------------------------------------
// Parallel block
// ---------------------------------------------------------------------------
export interface ParallelBlock extends Loc {
  readonly _tag: "ParallelBlock"
  readonly sessions: ReadonlyArray<SessionBlock>
}

// ---------------------------------------------------------------------------
// Pipeline block — a group of declarations that execute as a unit.
// Can contain sessions, pipes, let bindings, agent decls — anything.
// Used as the body of `loop until` for multi-agent iteration.
// ---------------------------------------------------------------------------
export interface PipelineBlock extends Loc {
  readonly _tag: "PipelineBlock"
  readonly declarations: ReadonlyArray<Declaration>
}

// ---------------------------------------------------------------------------
// Loop-until block — body is either a single session OR a pipeline of
// multiple declarations (sessions, pipes, etc.) that re-execute as a unit.
// ---------------------------------------------------------------------------
export interface LoopUntilBlock extends Loc {
  readonly _tag: "LoopUntilBlock"
  readonly condition: string
  readonly max?: number
  readonly body: SessionBlock | PipelineBlock
  readonly evaluate?: EvaluateAnnotation
}

// ---------------------------------------------------------------------------
// Pipe declaration
// ---------------------------------------------------------------------------
export interface PipeDecl extends Loc {
  readonly _tag: "PipeDecl"
  readonly from: string
  readonly to: string
  readonly on: "iteration" | "done" | "both"
  readonly strategy: PipeStrategy
}

// ---------------------------------------------------------------------------
// If block
// ---------------------------------------------------------------------------
export interface IfBranch extends Loc {
  readonly condition: string
  readonly body: ReadonlyArray<Declaration>
}

export interface IfBlock extends Loc {
  readonly _tag: "IfBlock"
  readonly condition: string
  readonly evaluate?: EvaluateAnnotation
  readonly then: ReadonlyArray<Declaration>
  readonly elifs?: ReadonlyArray<IfBranch>
  readonly else?: ReadonlyArray<Declaration>
}

// ---------------------------------------------------------------------------
// Map expression
// ---------------------------------------------------------------------------
export interface MapExpr extends Loc {
  readonly _tag: "MapExpr"
  readonly items: string
  readonly agent?: string
  readonly goal: string
  readonly varName?: string
  readonly parallel: boolean
}

// ---------------------------------------------------------------------------
// Reduce expression
// ---------------------------------------------------------------------------
export interface ReduceExpr extends Loc {
  readonly _tag: "ReduceExpr"
  readonly sources: ReadonlyArray<string>
  readonly agent?: string
  readonly goal: string
  readonly varName?: string
}

// ---------------------------------------------------------------------------
// Try/catch block
// ---------------------------------------------------------------------------
export interface TryBlock extends Loc {
  readonly _tag: "TryBlock"
  readonly body: ReadonlyArray<Declaration>
  readonly catchBody?: ReadonlyArray<Declaration>
  readonly retry?: number
  readonly backoff?: "linear" | "exponential"
}
