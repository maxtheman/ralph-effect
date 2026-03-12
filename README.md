# ralph-effect

An orchestrator for concurrent LLM agent loops, built on [Effect.ts](https://effect.website) and the [OpenAI Codex](https://openai.com/index/codex/) CLI app-server.

Ralph manages multiple Codex agents running in parallel — each pursuing a goal, evaluating its own progress, and refining its approach across iterations. Agents communicate through typed pipes, coordinate through dependency ordering, and terminate through structured evaluation. The `.prose` DSL scripting language compiles to ralph orchestrator calls, unifying program logic and natural language prompts into a single file.

> **Disclaimer**: ralph-effect is an experimental hackathon project. The `.prose` compiler is a DSL compiler — it parses a domain-specific language and emits typed orchestrator API calls, not machine code. It's a workflow scripting layer over LLM agents, not a general-purpose programming language.

## How It Works

### The Ralph Loop

Each agent runs in a **Huntley loop** — a goal-directed cycle:

```
Goal → Agent executes (Codex turn) → Evaluate → Refine → Loop
```

The agent receives a goal, works toward it in a sandboxed Codex session, then an evaluator decides whether the goal is met. If not, the agent loops with the evaluation feedback. This continues until the evaluator says "done" or max iterations are reached.

The evaluator can be:
- **LLM-as-judge** — a separate Codex turn that scores the output against the goal
- **A named agent** — another agent in the workflow evaluates
- **A lightweight check** — a deterministic function (`file-exists`, `json-valid`, `tests-pass`)

### Effect.ts Primitives

Ralph doesn't use ad-hoc concurrency. Every abstraction maps to a typed Effect primitive:

| Concept | Effect Primitive | Purpose |
|---------|-----------------|---------|
| Agent loop | `Effect.gen` + `Scope` | Structured concurrency with cleanup |
| Concurrent loops | `FiberMap` | Named fibers with lifecycle management |
| Inter-loop messaging | `Queue<LoopMessage>` | Typed, backpressured message passing |
| Observable state | `SubscriptionRef<LoopState>` | Reactive state with subscriber notification |
| Lifecycle events | `PubSub<LoopEvent>` | Broadcast events for monitoring and wiring |
| Service injection | `Context.Tag` + `Layer` | Dependency injection for Orchestrator and LLM |

This gives you structured concurrency with cancellation propagation, typed error channels, and resource safety — things that are hard to get right with raw promises.

### The Orchestrator

The orchestrator provides five core operations:

- **`fork(config)`** — Start an agent loop as a managed fiber
- **`pipe(config)`** — Wire one loop's output to another's input
- **`forkAfter(config, deps)`** — Fork a loop after its dependencies complete
- **`reduce(config)`** — Collect results from N loops, fork a reducer
- **`awaitAll()`** — Wait for all loops to complete

Three pipe strategies control how data flows between agents:

| Strategy | Behavior |
|----------|----------|
| `context` | Inject the full output as a structured context item |
| `notify` | Send a one-line signal ("Loop X completed iteration N") |
| `file` | Write output to a file path, notify the target of the path |

### Separated Context Model

A key design choice: the agent's **goal** and **injected context** are kept in separate channels. The goal (stored in `goalRef`) never grows beyond the original goal plus evaluator refinement. Injected context from pipes (stored in `contextRef`) flows through a sliding window. The evaluator only sees the goal — never the pipe noise. This prevents the common failure mode where concatenated context confuses the evaluation loop.

## OpenProse: `.prose` Scripting

OpenProse is a line-oriented, indentation-sensitive scripting language where every statement is simultaneously a program instruction and a natural language prompt. The parser is a hand-written recursive descent — no external grammar dependencies. The compiler emits live `Effect.Effect<void, Error, Orchestrator>` programs.

### Hello World

```prose
agent writer:
  model: sonnet
  prompt: You are a minimalist poet. Write only what is asked, nothing more.
  sandbox: workspace-write

let output_path = "examples/hello-world-output.md"

session: writer
  Write a haiku about recursion and save it to {{output_path}}
  max: 2
  evaluate:
    who: check:file-not-empty
    args: { path: examples/hello-world-output.md }
```

Run it:

```bash
npx tsx src/dsl/cli.ts examples/hello-world.prose
```

The compiler parses this into an AST, resolves the agent config, interpolates `{{output_path}}`, wires up the `file-not-empty` check as the evaluator, and emits an Effect program that calls `orch.fork()` with the assembled `LoopConfig`.

### Multi-Agent Workflow

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

This compiles to a dependency-ordered graph: poet runs first, then critic (after poet completes via `forkAfter`), then editor (after both). Pipe strategies control what data flows between them and how.

### Language Features

| Feature | Syntax | Compiles To |
|---------|--------|-------------|
| Agent declaration | `agent <name>:` | `AgentConfig` (personality, sandbox, model) |
| Session | `session: <agent>` | `orch.fork(config)` |
| Dependencies | `depends_on: [a, b]` | `orch.forkAfter(config, deps)` |
| Pipes | `pipe A -> B on done via context` | `orch.pipe(config)` |
| Parallel | `parallel:` block | Multiple concurrent `orch.fork()` |
| Loop until | `loop until **condition** (max: N):` | Loop with semantic evaluator |
| Variables | `let x = "value"` | Compile-time interpolation via `{{x}}` |
| If/elif/else | `if **semantic condition**:` | Evaluator branch |
| Map | `items \| map: session "goal"` | N parallel forks |
| Reduce | `items \| reduce: session "goal"` | `orch.reduce(config)` |
| Try/catch | `try:` / `catch:` / `retry: N` | `Effect.either` with retry + backoff |
| Evaluators | `evaluate: who: check:file-exists` | Check function, agent, or LLM-as-judge |

### The Compiler

> **Note**: This is a DSL compiler — it translates `.prose` scripts into typed Effect programs that call the ralph orchestrator API. It does not generate machine code, bytecode, or standalone executables. Think of it as closer to a build system or workflow engine compiler than a traditional language compiler.

The compiler walks the AST and produces typed Effect programs:

1. **Collect** agent declarations into a `Map<string, AgentConfig>`
2. **Topologically sort** sessions by `depends_on` (Kahn's algorithm with cycle detection)
3. **Compile** each node into orchestrator calls with variable interpolation
4. **Resolve** evaluators at compile time (self → LLM-as-judge, agent → named agent, check → deterministic function)
5. **Emit** `Effect.Effect<void, Error, Orchestrator>` that calls `orch.awaitAll()` at the end

Errors are caught at compile time with source line numbers: undefined variables, unknown agents, circular dependencies, missing check arguments, duplicate session names.

## Self-Hosting

The `.prose` compiler was built by ralph itself. Three agents — an implementer, an architect, and a critic — ran in a two-round loop:

1. **Round 1**: The implementer wrote all 7 source files from a spec document. The architect reviewed API design. The critic found bugs.
2. **Round 2**: The implementer read both reviews and addressed every finding — adding topological sort, fixing variable interpolation, improving error reporting, adding branch isolation for if-blocks.

The build script that orchestrated this (`examples/run-build-compiler.ts`) uses the same orchestrator primitives that the compiler targets: `fork`, `forkAfter`, and `pipe`. The compiler can parse `.prose` files that describe its own build process.

## Project Structure

```
src/
  ralph.ts          — The Huntley loop (goal → execute → evaluate → refine)
  orchestrator.ts   — Concurrent loop management (fork, pipe, forkAfter, reduce)
  codex-client.ts   — JSON-RPC transport for Codex app-server
  loop-types.ts     — Shared types (LoopState, LoopMessage, LoopEvent, etc.)
  repl.ts           — Interactive REPL for live orchestration
  dsl/
    ast.ts          — Discriminated union AST types
    parser.ts       — Recursive descent parser
    compiler.ts     — AST → Effect compiler
    checks.ts       — Built-in check evaluators
    evaluators.ts   — Evaluator routing (self, agent, check)
    index.ts        — Public API (loadWorkflow, runWorkflow)
    cli.ts          — CLI entry point
examples/
  hello-world.prose — Minimal single-agent workflow
  run-poetry-loop.ts      — Multi-agent poetry workshop (TypeScript)
  run-build-compiler.ts   — Self-hosting build loop (TypeScript)
```

## Requirements

- Node.js 22+
- [Codex CLI](https://github.com/openai/codex) running as app-server (`codex --app-server`)
- An OpenAI API key configured for Codex

## License

MIT
