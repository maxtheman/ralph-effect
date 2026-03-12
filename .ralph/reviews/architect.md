# Architecture Review: OpenProse Compiler

## Overall verdict

The implementation is only partially compliant with `specs/prose-compiler.md`. The AST surface and parser are close to the spec and can parse all seven spec examples, but the compiler architecture is not correct enough to satisfy the spec's orchestration requirements. The biggest problems are:

1. no topological sort before emission,
2. `PipeDecl`s are installed too late,
3. compile-time state is shared across mutually exclusive branches,
4. map/reduce agent selection is encoded with an unsafe `""` sentinel plus positional inference.

Those are architectural issues, not just polish.

## Highest-severity findings

### 1. `depends_on` is not topologically sorted, and the current execution order can deadlock

- The spec explicitly requires a topological sort before emitting orchestrator calls (`specs/prose-compiler.md:470-499`, `specs/prose-compiler.md:735-736`).
- The implementation only validates dependencies and cycles in `src/dsl/compiler.ts:185-272`.
- It then emits effects in original source order via `compileScope()` in `src/dsl/compiler.ts:637-655`; there is no sort pass.
- That matters because `compileSession()` emits `orch.forkAfter()` directly for dependent sessions in `src/dsl/compiler.ts:363-369`.
- `orch.forkAfter()` is a blocking Effect that waits for dependencies to finish before it returns (`src/orchestrator.ts:359-394`).

Consequence:

- If a session that depends on `A` appears before `A` in the source file, `compileScope()` will block inside `forkAfter(..., ["A"])` before `A` is ever forked.
- That is a real deadlock, not just a theoretical spec mismatch.

### 2. Pipes are wired after sessions, so `done` pipes can miss the only event that matters

- `compileScope()` deliberately splits declarations into "work" and "pipe" phases, then runs every `PipeDecl` after every non-pipe declaration in the same scope (`src/dsl/compiler.ts:641-655`).
- Pipe delivery in the orchestrator only happens when live `IterationComplete` or `Done` events are observed (`src/orchestrator.ts:243-281`).
- A pipe is only active after `orch.pipe()` succeeds (`src/orchestrator.ts:426-439`).

Consequence:

- In the spec's Test 2 shape, the compiler produces `fork(poet)`, then `forkAfter(critic, ["poet"])`, then `forkAfter(editor, ["poet", "critic"])`, and only after that does it call the two `pipe()` operations.
- Because `forkAfter()` waits for the dependency to finish before returning, the `poet -> critic on done` pipe is installed after `poet` has already emitted `Done`.
- That means the pipe never fires.

This is the most important correctness failure in the current compiler. The emitted call shapes are individually reasonable, but the ordering is wrong for the orchestrator API that actually exists.

### 3. Branch compilation is not isolated; untaken branches mutate shared compiler state

- The compiler keeps mutable global state in `CompileState` (`src/dsl/compiler.ts:31-39`).
- `compileIf()` eagerly compiles `then`, every `elif`, and `else` branch up front (`src/dsl/compiler.ts:532-543`).
- `compileTry()` eagerly compiles both `body` and `catchBody` (`src/dsl/compiler.ts:574-580`).
- `compileMap()` mutates `state.resultSets` when `varName` is present (`src/dsl/compiler.ts:456-458`).
- `compileReduce()` mutates `state.resultSets` too (`src/dsl/compiler.ts:514-516`).
- Agent inference consumes mutable cursor state in `resolveAgentName()` (`src/dsl/compiler.ts:274-291`).

Consequence:

- Symbols introduced inside an untaken branch can leak into later compilation.
- A `MapExpr` inside `else` can populate `resultSets` even when the `else` branch will never run.
- Branch-local use of implicit map/reduce agents can advance `implicitAgentCursor` for the rest of the program.

This makes the compiler context-sensitive in ways the AST does not express, and it will be difficult to reason about larger workflows.

### 4. Map/reduce agent selection is not represented soundly in the AST

- `MapExpr.agent` and `ReduceExpr.agent` are typed as required strings in `src/dsl/ast.ts:133-150`.
- The parser emits `""` when the syntax omits an agent (`src/dsl/parser.ts:746-754`, `src/dsl/parser.ts:777-783`).
- The compiler treats `""` as "infer an agent from declaration order" in `src/dsl/compiler.ts:274-291`, `src/dsl/compiler.ts:443-444`, and `src/dsl/compiler.ts:508-510`.
- That inference is backed by `implicitAgentNames`, which is populated by every collected `AgentDecl` in encounter order (`src/dsl/compiler.ts:89-129`).

Consequence:

- The AST is not precise: `agent: string` really means `explicit agent name | empty-string sentinel`.
- The runtime behavior of a map/reduce expression depends on unrelated declaration order.
- This behavior is not described in the spec's compilation rules, so it is surprising API surface rather than obvious DSL semantics.

This is both a type-safety problem and an ergonomics problem.

## Question-by-question assessment

### 1. Does the implementation match the spec?

Partially.

What matches:

- The requested file set exists: `ast.ts`, `parser.ts`, `compiler.ts`, `checks.ts`, `evaluators.ts`, `index.ts`, `cli.ts`.
- The parser API matches the spec shape (`src/dsl/parser.ts:27-35`, `src/dsl/parser.ts:860-863`).
- The compiler API matches the spec shape (`src/dsl/compiler.ts:22-29`, `src/dsl/compiler.ts:658-690`).
- The built-in checks required by the spec are present in `src/dsl/checks.ts:13-68`.
- Evaluator routing for `self`, `agent`, and `check` exists in `src/dsl/evaluators.ts:113-151`.

What does not match:

- No topological sort is performed before emission, despite being required by the spec (`src/dsl/compiler.ts:185-272` vs. `src/dsl/compiler.ts:637-655`).
- Pipe installation order is not compatible with the orchestrator's event-driven semantics (`src/dsl/compiler.ts:641-655`, `src/orchestrator.ts:243-281`, `src/orchestrator.ts:426-439`).
- The compiler introduces hidden positional agent inference for map/reduce, which is not part of the spec's explicit compilation rules (`src/dsl/compiler.ts:274-291`).

Bottom line: parser/check/evaluator coverage is close, but compiler correctness is not at spec level yet.

### 2. Are the AST types complete and correct?

Mostly complete, not fully correct.

What is good:

- The node inventory matches the spec: `Program`, `AgentDecl`, `LetDecl`, `SessionBlock`, `ParallelBlock`, `LoopUntilBlock`, `PipeDecl`, `IfBlock`, `MapExpr`, `ReduceExpr`, `TryBlock` are all present in `src/dsl/ast.ts:16-162`.
- `IfBranch` in `src/dsl/ast.ts:116-119` is a reasonable extension because it adds source location to `elif` branches.

What is not correct:

- `MapExpr.agent` and `ReduceExpr.agent` are typed as mandatory strings (`src/dsl/ast.ts:133-150`), but the parser clearly models absence with `""` (`src/dsl/parser.ts:750`, `src/dsl/parser.ts:781`).
- That means the AST cannot distinguish:
  - an explicit agent name,
  - omitted agent,
  - invalid empty string.

Recommended shape:

- Either make `agent?: string` for `MapExpr` and `ReduceExpr`, or add an explicit discriminant for `explicit` vs. `implicit` agent selection.

### 3. Is the parser handling all syntax cases from the spec?

Mostly yes.

Evidence that it covers the spec well:

- Comments and blank lines are removed in preprocessing (`src/dsl/parser.ts:121-158`).
- Multi-line session goals are accumulated in `parseSessionBlock()` (`src/dsl/parser.ts:342-411`).
- `**semantic condition**` extraction is implemented for loop-until and if/elif (`src/dsl/parser.ts:536-610`, `src/dsl/parser.ts:653-723`).
- `evaluate:` blocks, including nested `who:` and `args:`, are parsed in `src/dsl/parser.ts:414-499`.
- `parallel`, `map`, `reduce`, and `try/catch` syntax are all explicitly handled (`src/dsl/parser.ts:501-840`).

I also checked the seven prose examples from the spec against the parser, and all seven parse successfully.

Caveats:

- The parser is intentionally more permissive than the written grammar in a few places:
  - it allows `evaluate:` before the loop body in `loop until` (`src/dsl/parser.ts:556-563`), although the grammar places it after the session body;
  - it allows an optional explicit agent after `session` in `map` and `reduce` (`src/dsl/parser.ts:729`, `src/dsl/parser.ts:761`), which is not reflected in the informal grammar.

Those extensions are not fatal, but they show that the grammar, AST, and compiler semantics are not perfectly aligned.

### 4. Is the compiler producing correct orchestrator calls?

Only for simple cases.

What is correct:

- Sessions compile to `fork` / `forkAfter` in `src/dsl/compiler.ts:356-371`.
- Pipes compile to `pipe` in `src/dsl/compiler.ts:373-391`.
- Reduce compiles to `reduce` in `src/dsl/compiler.ts:504-530`.
- `awaitAll()` is appended at the end in `src/dsl/compiler.ts:677-684`.

What is incorrect:

- Call ordering is wrong because `compileScope()` is a linear source-order walk with deferred pipes (`src/dsl/compiler.ts:637-655`).
- Because `forkAfter()` and `reduce()` are blocking orchestration primitives (`src/orchestrator.ts:359-394`, `src/orchestrator.ts:453-513`), the compiler cannot safely treat them like cheap declarations in a single pass.
- The spec's dependency requirement really needs a schedule, not just per-node validation.

Specific failure modes:

- Non-topological declaration order can deadlock before later sessions are even forked.
- `done` pipes can be installed after the source loop is already done.
- Reduce can block the rest of the declaration stream in the same way that `forkAfter()` does.

So the answer is: the individual call shapes are mostly right, but the emitted program is not operationally correct for the real orchestrator API.

### 5. Are there any type safety issues?

Yes.

The main ones:

- Empty-string sentinel for omitted map/reduce agents (`src/dsl/ast.ts:133-150`, `src/dsl/parser.ts:746-754`, `src/dsl/parser.ts:777-783`).
- Shared mutable compiler state across nested scopes and mutually exclusive branches (`src/dsl/compiler.ts:31-39`, `src/dsl/compiler.ts:532-580`).
- `evaluate.args` is only `Record<string, string>` and is never validated against check-specific schemas (`src/dsl/parser.ts:92-119`, `src/dsl/compiler.ts:55-74`, `src/dsl/checks.ts:13-68`).
  - Example: `file-exists` and `file-not-empty` assume `args.path` exists; missing args degrade to runtime behavior like `File not found: undefined`.
- Cycle detection always reports line `1` (`src/dsl/compiler.ts:244-255`), which weakens diagnostic quality even though `CompileError` is line-based.

None of these break `tsc --noEmit`, but they are still real type/modeling problems.

### 6. API ergonomics: is the public interface clean?

Reasonably small, but not especially clean.

Positive:

- `src/dsl/index.ts` is easy to discover.
- `loadWorkflow()` and `runWorkflow()` are obvious entry points (`src/dsl/index.ts:10-44`).

Concerns:

- `loadWorkflow()` returns a nested effect (`Effect.Effect<Effect.Effect<void, Error, Orchestrator>, Error>`) in `src/dsl/index.ts:11-13`.
  - That is faithful to the staged parse/compile/run model, but it is awkward for callers.
- The public module also re-exports `parse` and `compile` (`src/dsl/index.ts:46-48`), which broadens the surface beyond the two primary workflow entry points.
- The map/reduce API is the biggest ergonomic issue: omitting an agent is legal in practice, but the behavior is hidden positional inference rather than explicit syntax.

My read is:

- The top-level module is acceptable.
- The DSL itself is not yet ergonomically clean because a user cannot predict map/reduce agent binding from the syntax alone.

## Recommended fixes

1. Add an explicit planning pass that:
   - topologically orders sessions,
   - determines when pipes must be installed,
   - separates "declare loop" from "wait for dependency" behavior.
2. Install pipes before the source event can fire. For `done` pipes, that usually means after both endpoints exist but before the source can complete.
3. Remove global mutable compile-state leakage across branches. Each branch should compile against an isolated snapshot, with explicit merge rules if needed.
4. Replace `""`-based map/reduce agent inference with an explicit AST representation.
5. Add argument validation for built-in checks and attach real source lines to cycle errors.

## Final assessment

The parser is in decent shape. The compiler is not yet architecturally sound enough for the spec, mainly because it emits a source-order Effect against an orchestrator API whose dependency and reduce operations are themselves blocking. Until that is fixed, I would treat this implementation as a promising parser plus a first compiler draft, not a spec-complete workflow engine.
