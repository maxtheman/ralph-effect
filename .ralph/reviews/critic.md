# DSL Critique

I read `specs/prose-compiler.md` and all of `src/dsl/*.ts`, then exercised the parser/compiler against the spec examples plus targeted edge cases.

## Findings

1. `src/dsl/compiler.ts:637-655` never performs the required topological sort. Declarations are emitted in source order, and `src/dsl/compiler.ts:356-371` immediately calls `orch.forkAfter(...)` for dependent sessions.
   Repro: a workflow with `b = session: worker` depending on `[a]` before `a = session: worker` emitted `forkAfter("b", ["a"])` and only then `fork("a")`.
   With the real orchestrator, `forkAfter` waits for dependencies before returning (`src/orchestrator.ts:359-393`), so the compiler can block before it ever reaches the dependency declaration. This misses the spec’s “Topological sort respects `dependsOn` ordering” and end-to-end “`depends_on` ordering respected” criteria.

2. `src/dsl/compiler.ts:641-655` deliberately moves every `PipeDecl` to the end of the scope. That is too late for `done` pipes.
   Repro call order from a stub orchestrator was `fork(a)`, `forkAfter(b, ["a"])`, `pipe(a, b)`, `awaitAll()` for a source-order workflow containing `a`, then `pipe a -> b`, then dependent `b`.
   In the poetry-workshop example, `pipe poet -> critic` and `pipe critic -> editor` can both be registered after the relevant sessions have already completed, so the target loops never receive the intended context/file notifications. This misses the spec’s `PipeDecl -> orch.pipe()` timing, `Pipes wire correctly from .prose declarations`, and likely `Poetry workshop .prose file runs end-to-end`.

3. Variable interpolation is inconsistent with the parser’s identifier grammar.
   `src/dsl/parser.ts:36-37` allows identifiers matching `[A-Za-z_][A-Za-z0-9_-]*`, so `foo-bar` is a valid variable name.
   `src/dsl/compiler.ts:45-53` only interpolates `/\{\{(\w+)\}\}/g`, which excludes `-`.
   Repro: `let foo-bar = "VALUE"` plus `Write {{foo-bar}}` compiled successfully, but the emitted loop goal was still `Write {{foo-bar}}` with no compile error.
   This misses the spec’s `LetDecl` substitution criterion for valid variable names accepted by the parser.

4. Circular-dependency errors do not report the correct source line.
   `src/dsl/compiler.ts:244-271` detects cycles, but line 255 hard-codes `addError(state, 1, ...)`.
   Repro: a cycle between sessions declared later in the file still reported `Line 1: Circular dependency detected: a -> b -> a`.
   Unknown-agent and undefined-variable compile errors do carry useful line numbers; cycle errors do not.

5. Session-block indentation handling is too permissive and silently misparses malformed metadata.
   `src/dsl/parser.ts:368-392` only recognizes `max:`, `depends_on:`, and `evaluate:` when they are exactly one indent level under the session header.
   Anything deeper falls through to goal text via `src/dsl/parser.ts:394-395` and `src/dsl/parser.ts:843-845`.
   Repro:

   ```prose
   session: worker
       max: 3
   ```

   parses successfully as a session whose goal is `"  max: 3"` instead of reporting bad indentation.
   That means even-space indentation mistakes can be silently accepted as user goal text. This misses the parser acceptance criterion for handling indentation-delimited blocks correctly.

6. `src/dsl/evaluators.ts:10-28` treats `FAILED: ...` as `{ done: true }`.
   That means `evaluateCondition()` at `src/dsl/evaluators.ts:153-175` can take the `if`/`elif` true branch on an evaluator failure, and loop evaluators can terminate a loop on `FAILED` rather than continuing or surfacing a failure.
   The prompt templates at `src/dsl/evaluators.ts:62-65`, `src/dsl/evaluators.ts:77-80`, and `src/dsl/evaluators.ts:90-93` clearly distinguish `DONE`, `CONTINUE`, and `FAILED`, so collapsing `FAILED` into success is a semantic bug.

## Edge-Case Parser Checks

- Empty file: `parse("")` returns `ok: true` with `Program.declarations = []`, and `compile()` also returns `ok: true`. The spec does not explicitly forbid empty workflows, but there is no validation that a workflow contains at least one declaration.
- Odd indentation: `session: worker` followed by a line indented by 3 spaces correctly reports `Indentation must be in multiples of 2 spaces` on the offending line.
- Missing goal: `session: worker` followed only by `max: 3` correctly reports `Session block requires at least one goal line`.
- Missing evaluator target: an `evaluate:` block with only `args:` correctly reports `Evaluate block requires \`who:\``.

## Error Handling

- Parse errors generally include line numbers. The odd-indentation, missing-goal, and missing-`who:` repros all reported the correct lines.
- Compile errors also generally include line numbers. `Unknown agent: ghost` reported line 1, and `Undefined variable: missing` reported the session line where `{{missing}}` appeared.
- The exception is cycle detection, which always reports line 1 because of the hard-coded line number in `src/dsl/compiler.ts:255`.

## Acceptance Criteria Not Met

- Parser: `Handles indentation-delimited blocks correctly` is not met because misindented session metadata is silently treated as goal text.
- Compiler: `LetDecl variable substitution in {{var}} works` is not fully met because valid hyphenated identifiers are never interpolated.
- Compiler: `Topological sort respects dependsOn ordering` is not met; there is no sort.
- End-to-end: `Poetry workshop .prose file runs end-to-end` is not met with the current pipe scheduling.
- End-to-end: `Pipes wire correctly from .prose declarations` is not met because pipes are emitted after non-pipe work.
- End-to-end: `depends_on` ordering respected is not met when dependent sessions appear before their dependencies in source order.

## Import / Type Hygiene

- I did not find `.js` extension problems in `src/dsl/*.ts`; the relative imports are consistently written with `.js`.
- I did not find obvious value-vs-type import mistakes in `src/dsl/*.ts`; `import type` is used where the imported symbol is only referenced in types.
