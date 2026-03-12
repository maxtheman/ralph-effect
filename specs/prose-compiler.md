# OpenProse-to-Ralph Compiler Specification

## Overview

Build a compiler that reads `.prose` workflow files (OpenProse-compatible syntax) and produces `Effect<void, Error, Orchestrator>` programs that drive the ralph orchestrator.

The compiler lives in `src/dsl/` and has four main parts:
1. **AST types** (`ast.ts`) — TypeScript discriminated unions for every syntax node
2. **Parser** (`parser.ts`) — recursive descent parser: `.prose` text -> AST
3. **Compiler** (`compiler.ts`) — AST -> Effect program using the Orchestrator service
4. **Built-in checks** (`checks.ts`) — lightweight evaluator functions (file-exists, tests-pass, etc.)
5. **Evaluator routing** (`evaluators.ts`) — resolve `evaluate:` annotations to `Evaluator` functions
6. **Public API** (`index.ts`) — `loadWorkflow(path)` and `runWorkflow(ast)`

## Part 1: AST Types (`src/dsl/ast.ts`)

Every `.prose` construct maps to a TypeScript node. All nodes carry `line: number` for error reporting.

```typescript
// src/dsl/ast.ts
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
// Declarations (top-level statements)
// ---------------------------------------------------------------------------
export type Declaration =
  | AgentDecl
  | LetDecl
  | SessionBlock
  | ParallelBlock
  | LoopUntilBlock
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
  readonly constant: boolean  // true for `const`, false for `let`
}

// ---------------------------------------------------------------------------
// Session block (single ralph loop)
// ---------------------------------------------------------------------------
export interface SessionBlock extends Loc {
  readonly _tag: "SessionBlock"
  /** Variable name to bind the session to (for pipes/depends) */
  readonly varName?: string
  /** Agent name (references an AgentDecl) */
  readonly agent: string
  /** Goal text (may contain {{variable}} interpolation) */
  readonly goal: string
  /** Max iterations (default: 10) */
  readonly max?: number
  /** Session IDs this session depends on */
  readonly dependsOn?: ReadonlyArray<string>
  /** Evaluator annotation */
  readonly evaluate?: EvaluateAnnotation
}

// ---------------------------------------------------------------------------
// Evaluate annotation — WHO judges semantic conditions
// ---------------------------------------------------------------------------
export type EvaluateAnnotation =
  | { readonly _tag: "self" }                                    // default: loop's own Codex thread
  | { readonly _tag: "agent"; readonly agentName: string }       // named agent evaluates
  | { readonly _tag: "check"; readonly checkName: string; readonly args?: Record<string, string> }  // lightweight check function

// ---------------------------------------------------------------------------
// Parallel block — fork multiple sessions concurrently
// ---------------------------------------------------------------------------
export interface ParallelBlock extends Loc {
  readonly _tag: "ParallelBlock"
  readonly sessions: ReadonlyArray<SessionBlock>
}

// ---------------------------------------------------------------------------
// Loop-until block — repeat session until semantic condition met
// ---------------------------------------------------------------------------
export interface LoopUntilBlock extends Loc {
  readonly _tag: "LoopUntilBlock"
  /** Semantic condition in **bold** */
  readonly condition: string
  /** Max iterations for the loop */
  readonly max?: number
  /** The session to repeat */
  readonly body: SessionBlock
  /** Who evaluates the condition */
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
// If block — branch on semantic condition
// ---------------------------------------------------------------------------
export interface IfBlock extends Loc {
  readonly _tag: "IfBlock"
  readonly condition: string
  readonly evaluate?: EvaluateAnnotation
  readonly then: ReadonlyArray<Declaration>
  readonly elifs?: ReadonlyArray<{ condition: string; body: ReadonlyArray<Declaration> }>
  readonly else?: ReadonlyArray<Declaration>
}

// ---------------------------------------------------------------------------
// Map expression — parallel map over items
// ---------------------------------------------------------------------------
export interface MapExpr extends Loc {
  readonly _tag: "MapExpr"
  /** Variable name holding the items to map over */
  readonly items: string
  /** Agent to use for each item */
  readonly agent: string
  /** Goal template ({{item}} is replaced per element) */
  readonly goal: string
  /** Variable name to bind results to */
  readonly varName?: string
  /** Whether to run in parallel (pmap) or sequential (map) */
  readonly parallel: boolean
}

// ---------------------------------------------------------------------------
// Reduce expression — sequential aggregation
// ---------------------------------------------------------------------------
export interface ReduceExpr extends Loc {
  readonly _tag: "ReduceExpr"
  /** Source session IDs to collect results from */
  readonly sources: ReadonlyArray<string>
  /** The reducer session config */
  readonly agent: string
  readonly goal: string
  readonly varName?: string
}

// ---------------------------------------------------------------------------
// Try/catch block — error handling with retry
// ---------------------------------------------------------------------------
export interface TryBlock extends Loc {
  readonly _tag: "TryBlock"
  readonly body: ReadonlyArray<Declaration>
  readonly catchBody?: ReadonlyArray<Declaration>
  readonly retry?: number
  readonly backoff?: "linear" | "exponential"
}
```

## Part 2: Parser (`src/dsl/parser.ts`)

Hand-written recursive descent parser. No external dependencies (no nearley/PEG — keep it simple).

### Grammar (informal)

The `.prose` format is line-oriented and indentation-sensitive (2-space indent = nested block).

```
program       = declaration*
declaration   = agentDecl | letDecl | sessionBlock | parallelBlock
              | loopUntilBlock | pipeDecl | ifBlock | mapExpr
              | reduceExpr | tryBlock

agentDecl     = "agent" IDENT ":"
                  ("model:" IDENT)?
                  ("prompt:" TEXT)?
                  ("sandbox:" ("read-only" | "workspace-write"))?
                  ("writableRoots:" "[" pathList "]")?

letDecl       = ("let" | "const") IDENT "=" QUOTEDSTRING

sessionBlock  = (IDENT "=")? "session:" IDENT
                  GOALTEXT+
                  ("max:" NUMBER)?
                  ("depends_on:" "[" identList "]")?
                  ("evaluate:" evaluateAnnotation)?

parallelBlock = "parallel:"
                  sessionBlock+

loopUntilBlock = "loop until" SEMANTICCOND ("(max:" NUMBER ")")?  ":"
                  sessionBlock
                  ("evaluate:" evaluateAnnotation)?

pipeDecl      = "pipe" IDENT "->" IDENT "on" TRIGGER "via" STRATEGY (PATH)?

ifBlock       = "if" SEMANTICCOND ":"
                  declaration+
                ("elif" SEMANTICCOND ":"
                  declaration+)*
                ("else:"
                  declaration+)?

mapExpr       = (IDENT "=")? IDENT "|" ("map" | "pmap") ":" "session" QUOTEDGOAL

reduceExpr    = (IDENT "=")? IDENT "|" "reduce" "(" IDENT "," IDENT ")" ":" "session" QUOTEDGOAL

tryBlock      = "try:"
                  declaration+
                ("catch:"
                  declaration+)?
                ("retry:" NUMBER)?
                ("backoff:" ("linear" | "exponential"))?

evaluateAnnotation = "who:" ("self" | "agent:" IDENT | "check:" IDENT)
                     ("args:" "{" keyValuePairs "}")?

SEMANTICCOND  = "**" TEXT "**"
TRIGGER       = "iteration" | "done" | "both"
STRATEGY      = "context" | "notify" | "file"
GOALTEXT      = indented text line (may contain {{var}} interpolation)
QUOTEDSTRING  = '"' TEXT '"'
```

### Parser API

```typescript
// src/dsl/parser.ts
import type { Program } from "./ast.js"

export interface ParseError {
  readonly line: number
  readonly message: string
}

export type ParseResult =
  | { readonly ok: true; readonly program: Program }
  | { readonly ok: false; readonly errors: ReadonlyArray<ParseError> }

/** Parse a .prose file into an AST */
export const parse = (source: string): ParseResult => { ... }
```

### Implementation Notes

- Line-oriented: split on `\n`, track current line index and indentation level
- Indentation: 2 spaces = one indent level. Blocks are delimited by indent increase/decrease.
- `{{variable}}` interpolation: kept as literal strings in the AST. The compiler resolves them.
- `**semantic condition**`: extract text between `**` markers
- Goal text: consecutive indented lines under a session block that don't match a keyword (`max:`, `depends_on:`, `evaluate:`) are joined as the goal string
- Comments: lines starting with `#` are ignored
- Blank lines: ignored (don't affect indentation tracking)

### Parser Test Cases

The parser must correctly parse these examples:

**Test 1: Minimal session**
```prose
agent worker:
  model: sonnet
  prompt: You are a code writer.
  sandbox: workspace-write

session: worker
  Write a fizzbuzz function in TypeScript.
  max: 3
```
Expected AST: Program with AgentDecl + SessionBlock.

**Test 2: Poetry workshop (pipes + depends_on)**
```prose
agent poet:
  model: sonnet
  prompt: You are a modernist poet who values concrete imagery.
  sandbox: workspace-write

agent critic:
  model: sonnet
  prompt: You are a demanding poetry critic focused on craft.
  sandbox: read-only

agent editor:
  model: opus
  prompt: You synthesize feedback into a final polished version.
  sandbox: workspace-write

let poem_path = "examples/poem.md"
let critique_path = "examples/critique.md"

session: poet
  Write an original 4-stanza poem about recursion.
  Write it to {{poem_path}}
  max: 3

pipe poet -> critic on done via file {{poem_path}}

session: critic
  depends_on: [poet]
  Read {{poem_path}} and write a sharp line-level critique
  to {{critique_path}}
  max: 2

pipe critic -> editor on done via context

session: editor
  depends_on: [poet, critic]
  Read {{poem_path}} and {{critique_path}}.
  Produce a final polished version at examples/poem-final.md
  max: 2
  evaluate:
    who: check:file-not-empty
    args: { path: examples/poem-final.md }
```

**Test 3: Parallel block**
```prose
agent researcher:
  prompt: You research topics thoroughly.
  sandbox: read-only

parallel:
  api_research = session: researcher
    Research REST API best practices.
    max: 2
  db_research = session: researcher
    Research database indexing strategies.
    max: 2
```

**Test 4: Loop-until with semantic condition**
```prose
agent coder:
  prompt: You write TypeScript code.
  sandbox: workspace-write

loop until **all tests pass** (max: 5):
  session: coder
    Fix the failing tests in src/utils.test.ts
    evaluate:
      who: check:tests-pass
      args: { command: npx vitest run }
```

**Test 5: Map and reduce**
```prose
agent analyst:
  prompt: You analyze code files.
  sandbox: read-only

agent summarizer:
  prompt: You synthesize analysis results.
  sandbox: workspace-write

let files = "src/a.ts, src/b.ts, src/c.ts"

results = files | pmap: session "Analyze {{item}} for code quality issues"

summary = results | reduce(acc, r): session "Combine these analyses into a report"
```

**Test 6: If block with semantic condition**
```prose
if **the tests are passing**:
  session: deployer
    Deploy to staging.
    max: 1
elif **the tests have minor failures**:
  session: fixer
    Fix the minor test failures.
    max: 3
else:
  session: debugger
    Debug the test failures and report findings.
    max: 5
```

**Test 7: Try/catch with retry**
```prose
try:
  session: deployer
    Deploy the application to production.
    max: 2
catch:
  session: rollback
    Rollback the deployment and report what went wrong.
    max: 1
retry: 3
backoff: exponential
```

## Part 3: Compiler (`src/dsl/compiler.ts`)

Walks the AST and produces an `Effect<void, Error, Orchestrator>` that drives the orchestrator.

### Compiler API

```typescript
// src/dsl/compiler.ts
import { Effect } from "effect"
import type { Program } from "./ast.js"
import type { Orchestrator } from "../orchestrator.js"

export interface CompileError {
  readonly line: number
  readonly message: string
}

export type CompileResult =
  | { readonly ok: true; readonly effect: Effect.Effect<void, Error, Orchestrator> }
  | { readonly ok: false; readonly errors: ReadonlyArray<CompileError> }

/** Compile a parsed AST into an Effect that drives the orchestrator */
export const compile = (program: Program): CompileResult => { ... }
```

### Compilation Rules

Each AST node compiles to orchestrator calls:

| AST Node | Orchestrator Call(s) |
|----------|---------------------|
| `AgentDecl` | Stored in `Map<string, AgentConfig>` for session lookup |
| `LetDecl` | Stored in `Map<string, string>` for `{{var}}` interpolation |
| `SessionBlock` | `orch.fork(loopConfig)` or `orch.forkAfter(config, deps)` if `dependsOn` |
| `ParallelBlock` | Multiple `orch.fork()` calls (no ordering) |
| `LoopUntilBlock` | `orch.fork()` with custom evaluator from condition |
| `PipeDecl` | `orch.pipe(pipeConfig)` |
| `IfBlock` | Evaluate semantic condition, branch on result |
| `MapExpr` | Split items, fork parallel sessions, collect results |
| `ReduceExpr` | `orch.reduce(reduceConfig)` |
| `TryBlock` | `Effect.catchAll` with optional retry logic |

### Compilation Steps

1. **Collect declarations**: First pass — gather all `AgentDecl` into `agents: Map<string, AgentConfig>` and all `LetDecl` into `vars: Map<string, string>`.

2. **Resolve variables**: Replace all `{{varName}}` occurrences in goal text and paths with values from the vars map. Error if a variable is not defined.

3. **Topological sort**: Sort `SessionBlock` nodes by `dependsOn`. If A depends on B, B must be forked before A. Circular dependencies are an error.

4. **Compile nodes**: Walk sorted declarations and emit Effect code:

```typescript
// Pseudocode for session compilation
const compileSession = (session: SessionBlock, agents: Map, vars: Map) => {
  const agentConfig = agents.get(session.agent)
  if (!agentConfig) throw CompileError(session.line, `Unknown agent: ${session.agent}`)

  const goal = interpolate(session.goal, vars)
  const loopConfig: LoopConfig = {
    id: session.varName ?? session.agent,
    goal,
    maxIterations: session.max ?? 10,
    verbose: true,
    agent: agentConfig,
    evaluator: session.evaluate ? resolveEvaluator(session.evaluate) : undefined
  }

  if (session.dependsOn && session.dependsOn.length > 0) {
    return orch.forkAfter(loopConfig, session.dependsOn)
  }
  return orch.fork(loopConfig)
}
```

5. **Wire pipes**: After forking sessions, compile `PipeDecl` nodes into `orch.pipe()` calls.

6. **Await**: End with `orch.awaitAll()`.

### Variable Interpolation

```typescript
const interpolate = (text: string, vars: Map<string, string>): string =>
  text.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    const value = vars.get(name)
    if (value === undefined) throw new Error(`Undefined variable: ${name}`)
    return value
  })
```

### Semantic Condition Compilation

`**text**` conditions compile to evaluator calls:

```typescript
const compileSemantic = (condition: string, evaluate?: EvaluateAnnotation) => {
  // Returns an Evaluator that checks the condition
  // Default (self): uses the loop's own Codex thread as judge
  // agent:<name>: creates a separate thread with that agent's config
  // check:<name>: uses a built-in check function
}
```

## Part 4: Built-in Checks (`src/dsl/checks.ts`)

Lightweight evaluator functions that don't need LLM calls.

```typescript
// src/dsl/checks.ts
import { Effect } from "effect"
import type { EvalResult } from "../loop-types.js"

export type CheckFn = (args: Record<string, string>) => (goal: string, output: string) => Effect.Effect<EvalResult, Error>

export const builtinChecks: Record<string, CheckFn> = {
  "file-exists": (args) => (_goal, _output) =>
    Effect.try({
      try: () => {
        const fs = require("node:fs")
        return fs.existsSync(args.path)
          ? { done: true, reason: "File exists" }
          : { done: false, reason: `File not found: ${args.path}` }
      },
      catch: (e) => new Error(`Check failed: ${e}`)
    }),

  "file-not-empty": (args) => (_goal, _output) =>
    Effect.try({
      try: () => {
        const fs = require("node:fs")
        const stat = fs.statSync(args.path)
        return stat.size > 0
          ? { done: true, reason: "File is not empty" }
          : { done: false, reason: `File is empty: ${args.path}` }
      },
      catch: (e) => new Error(`Check failed: ${e}`)
    }),

  "json-valid": (args) => (_goal, _output) =>
    Effect.try({
      try: () => {
        const fs = require("node:fs")
        const content = fs.readFileSync(args.path, "utf-8")
        JSON.parse(content)
        return { done: true, reason: "Valid JSON" }
      },
      catch: () => new Error("Invalid JSON")
    }).pipe(Effect.catchAll((e) =>
      Effect.succeed({ done: false, reason: `Invalid JSON: ${e.message}` })
    )),

  "tests-pass": (args) => (_goal, _output) =>
    Effect.try({
      try: () => {
        const { execSync } = require("node:child_process")
        execSync(args.command ?? "npm test", { stdio: "pipe" })
        return { done: true, reason: "Tests pass" }
      },
      catch: (e: any) => new Error(e.stderr?.toString() ?? "Tests failed")
    }).pipe(Effect.catchAll((e) =>
      Effect.succeed({ done: false, reason: `Tests failed: ${e.message.slice(0, 200)}` })
    ))
}
```

## Part 5: Evaluator Routing (`src/dsl/evaluators.ts`)

Resolves `evaluate:` annotations to `Evaluator` functions.

```typescript
// src/dsl/evaluators.ts
import type { Evaluator } from "../loop-types.js"
import type { EvaluateAnnotation } from "./ast.js"
import { builtinChecks } from "./checks.js"

/** Resolve an evaluate annotation to an Evaluator function */
export const resolveEvaluator = (
  annotation: EvaluateAnnotation,
  agents: Map<string, AgentConfig>
): Evaluator | undefined => {
  switch (annotation._tag) {
    case "self":
      return undefined  // undefined means: use default LLM-as-judge

    case "agent": {
      // Create evaluator that uses a separate agent's perspective
      const config = agents.get(annotation.agentName)
      if (!config) throw new Error(`Unknown agent: ${annotation.agentName}`)
      // Returns evaluator that creates a one-shot thread with agent's personality
      return (goal, output) => { ... }
    }

    case "check": {
      const checkFn = builtinChecks[annotation.checkName]
      if (!checkFn) throw new Error(`Unknown check: ${annotation.checkName}`)
      return checkFn(annotation.args ?? {})
    }
  }
}
```

## Part 6: Public API (`src/dsl/index.ts`)

```typescript
// src/dsl/index.ts
import { Effect } from "effect"
import * as fs from "node:fs"
import { parse } from "./parser.js"
import { compile } from "./compiler.js"
import type { Orchestrator } from "../orchestrator.js"

/** Load and compile a .prose workflow file */
export const loadWorkflow = (
  filePath: string
): Effect.Effect<Effect.Effect<void, Error, Orchestrator>, Error> =>
  Effect.gen(function* () {
    const source = yield* Effect.try({
      try: () => fs.readFileSync(filePath, "utf-8"),
      catch: (e) => new Error(`Failed to read ${filePath}: ${e}`)
    })

    const parseResult = parse(source)
    if (!parseResult.ok) {
      const msgs = parseResult.errors.map((e) => `  Line ${e.line}: ${e.message}`).join("\n")
      return yield* Effect.fail(new Error(`Parse errors:\n${msgs}`))
    }

    const compileResult = compile(parseResult.program)
    if (!compileResult.ok) {
      const msgs = compileResult.errors.map((e) => `  Line ${e.line}: ${e.message}`).join("\n")
      return yield* Effect.fail(new Error(`Compile errors:\n${msgs}`))
    }

    return compileResult.effect
  })

/** Parse, compile, and run a .prose workflow */
export const runWorkflow = (filePath: string) =>
  Effect.gen(function* () {
    const workflow = yield* loadWorkflow(filePath)
    yield* workflow
  })

// Re-export types
export type { Program, Declaration } from "./ast.js"
export { parse } from "./parser.js"
export { compile } from "./compiler.js"
```

## Part 7: CLI Entry Point (`src/dsl/cli.ts`)

```typescript
// src/dsl/cli.ts
import { Effect, Console } from "effect"
import { OrchestratorLive } from "../orchestrator.js"
import { CodexLLMLive } from "../codex-client.js"
import { runWorkflow } from "./index.js"

const filePath = process.argv[2]
if (!filePath) {
  console.log("Usage: npx tsx src/dsl/cli.ts <workflow.prose>")
  process.exit(1)
}

const main = runWorkflow(filePath).pipe(
  Effect.provide(OrchestratorLive),
  Effect.provide(CodexLLMLive),
  Effect.scoped,
  Effect.catchAll((e) => Console.log(`Workflow failed: ${e}`))
)

Effect.runPromise(main)
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
```

## File Structure

```
src/dsl/
  ast.ts           — AST node types (discriminated unions)
  parser.ts        — Recursive descent .prose parser
  compiler.ts      — AST -> Effect<void, Error, Orchestrator>
  checks.ts        — Built-in check evaluators
  evaluators.ts    — Evaluate annotation routing
  index.ts         — Public API (loadWorkflow, runWorkflow)
  cli.ts           — CLI entry point
```

## Acceptance Criteria

### Parser
- [ ] Parses all 7 test cases from this spec into valid ASTs
- [ ] Reports line numbers in parse errors
- [ ] Handles comments (`#` lines)
- [ ] Handles blank lines
- [ ] Handles `{{variable}}` in goal text (preserved in AST)
- [ ] Handles `**semantic condition**` extraction
- [ ] Handles indentation-delimited blocks correctly
- [ ] Handles multi-line goal text (consecutive indented lines)

### Compiler
- [ ] `AgentDecl` -> `AgentConfig` mapping works
- [ ] `LetDecl` variable substitution in `{{var}}` works
- [ ] `SessionBlock` -> `orch.fork()` with correct `LoopConfig`
- [ ] `SessionBlock` with `dependsOn` -> `orch.forkAfter()`
- [ ] `ParallelBlock` -> multiple concurrent `orch.fork()` calls
- [ ] `PipeDecl` -> `orch.pipe()` with correct strategy
- [ ] `ReduceExpr` -> `orch.reduce()` call
- [ ] `LoopUntilBlock` -> loop with custom evaluator
- [ ] Topological sort respects `dependsOn` ordering
- [ ] Circular dependency detection
- [ ] Unknown agent name -> compile error with line number
- [ ] Undefined variable -> compile error with line number

### Checks
- [ ] `file-exists` check returns correct `EvalResult`
- [ ] `file-not-empty` check returns correct `EvalResult`
- [ ] `json-valid` check returns correct `EvalResult`
- [ ] `tests-pass` check runs command and returns correct `EvalResult`

### Evaluator Routing
- [ ] `self` -> returns `undefined` (use default)
- [ ] `agent:<name>` -> returns evaluator with agent personality
- [ ] `check:<name>` -> returns built-in check evaluator
- [ ] Unknown check name -> error

### End-to-End
- [ ] Poetry workshop `.prose` file (Test 2) runs end-to-end
- [ ] Parallel block forks concurrent loops
- [ ] Pipes wire correctly from `.prose` declarations
- [ ] `depends_on` ordering respected
- [ ] `evaluate:` annotations route to correct evaluator
- [ ] CLI entry point works: `npx tsx src/dsl/cli.ts workflow.prose`

### Code Quality
- [ ] TypeScript compiles with zero errors (`npx tsc --noEmit`)
- [ ] No external dependencies added (parser is hand-written)
- [ ] All files have JSDoc module headers
- [ ] Exports are clean (index.ts re-exports only public API)

## Constraints

- **No new dependencies**: Use recursive descent (no nearley, no PEG). The parser is ~200-400 lines.
- **Effect-native**: All compiler output is Effect code. Use `Effect.gen`, `Effect.forEach`, etc.
- **Existing types**: Import from `../loop-types.js` and `../orchestrator.js`. Do NOT duplicate types.
- **File paths**: All imports use `.js` extensions (ESM convention in this project).
- **tsconfig**: The project uses `"module": "nodenext"` and `"moduleResolution": "nodenext"`.

## Example: Compiled Output

For the poetry workshop (Test 2), the compiler should produce an Effect equivalent to:

```typescript
Effect.gen(function* () {
  const orch = yield* Orchestrator

  // Sessions (respecting depends_on order)
  yield* orch.fork({
    id: "poet",
    goal: 'Write an original 4-stanza poem about recursion.\nWrite it to examples/poem.md',
    maxIterations: 3,
    verbose: true,
    agent: { personality: "You are a modernist poet...", sandbox: "workspace-write" }
  })

  // Pipes (can be wired immediately after source is forked)
  yield* orch.pipe({
    from: "poet", to: "critic",
    on: "done",
    strategy: { _tag: "file", path: "examples/poem.md" }
  })

  yield* orch.forkAfter({
    id: "critic",
    goal: 'Read examples/poem.md and write a sharp line-level critique\nto examples/critique.md',
    maxIterations: 2,
    verbose: true,
    agent: { personality: "You are a demanding poetry critic...", sandbox: "read-only" }
  }, ["poet"])

  yield* orch.pipe({
    from: "critic", to: "editor",
    on: "done",
    strategy: { _tag: "context" }
  })

  yield* orch.forkAfter({
    id: "editor",
    goal: 'Read examples/poem.md and examples/critique.md.\nProduce a final polished version at examples/poem-final.md',
    maxIterations: 2,
    verbose: true,
    agent: { personality: "You synthesize feedback...", sandbox: "workspace-write" },
    evaluator: builtinChecks["file-not-empty"]({ path: "examples/poem-final.md" })
  }, ["poet", "critic"])

  yield* orch.awaitAll()
})
```

## Build Loop Configuration

This compiler will be built by ralph using an implementer-architect-critique loop. The build loop `.prose` file itself is provided separately in `specs/build-compiler.prose`.
