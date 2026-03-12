# Phase 4: Dynamic Agent Dashboard — Specification

> Build a web dashboard that replaces the terminal REPL with a browser-based control surface
> for the ralph orchestrator. Agents can dynamically generate their own UIs via json-render.

## Overview

The dashboard wraps the existing `OrchestratorService` in a Hono HTTP server and presents a
React frontend using AI Elements for orchestrator controls and json-render for agent-generated UIs.

The system has three layers:

1. **Hono HTTP server** (`src/server.ts`) — REST API + SSE wrapping the Orchestrator
2. **React frontend** (`frontend/`) — Vite-built React 19 app
3. **Component catalog** (`frontend/src/catalog.ts`) — Zod-constrained json-render components

```
.prose → compile → Effect program → agents run → agents emit JSON UI → json-render → live dashboard
```

## Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| HTTP | Hono + @hono/node-server | Lightweight, SSE built-in via `streamSSE`, Vite middleware |
| Frontend | React 19 + Vite | Required by json-render and AI Elements |
| Dynamic UI | json-render + @json-render/react | Agents emit JSON specs → rendered as React components |
| Components | AI Elements (shadcn/ui) | Pre-built: Messages, Tool, Reasoning, Canvas, CodeBlock |
| Workflow viz | @xyflow/react (React Flow) | Canvas nodes = loops, edges = pipes |
| Styling | Tailwind CSS 4 | AI Elements dependency |
| Real-time | SSE (Hono streamSSE) | Event stream from PubSub<LoopEvent> |

## Existing Code Reference

The dashboard wraps the **existing** orchestrator — no modifications to core files:

- `src/orchestrator.ts` — `OrchestratorService` interface with `fork`, `forkAfter`, `pipe`, `unpipe`, `pipes`, `reduce`, `status`, `statusAll`, `send`, `interrupt`, `subscribe`, `awaitAll`
- `src/loop-types.ts` — `LoopState`, `LoopEvent` (Started/IterationComplete/Done/Failed/Interrupted), `LoopMessage` (UserMessage/SetGoal/Pause/Resume/SetMaxIterations/InjectContext/ClearContext), `AgentConfig`, `PipeStrategy`, `EvalResult`, `LoopConfig`
- `src/codex-client.ts` — `CodexLLM` service (spawns Codex app-server over stdio)
- `src/dsl/index.ts` — `loadWorkflow(path)`, `runWorkflow(path)` for .prose files
- `src/repl.ts` — The terminal REPL this dashboard replaces (use as feature parity reference)

**Important**: The orchestrator uses Effect.ts. The server must provide `OrchestratorLive` and `CodexLLMLive` layers. Use `Effect.runPromise` or `Effect.runSync` at the HTTP handler boundary.

## Part 1: Hono HTTP Server (`src/server.ts`)

### API Routes

All routes wrap the `OrchestratorService` interface. The server holds a reference to an Effect runtime
with `Orchestrator + CodexLLM` layers provided.

```typescript
// src/server.ts
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { Effect, Queue } from "effect"
import { Orchestrator, OrchestratorLive } from "./orchestrator.js"
import { CodexLLMLive } from "./codex-client.js"
import type { LoopEvent, LoopMessage, PipeStrategy } from "./loop-types.js"
import { LoopMessage as LM } from "./loop-types.js"
```

#### REST Endpoints

| Method | Path | Orchestrator Call | Request Body | Response |
|--------|------|-------------------|-------------|----------|
| GET | `/api/status` | `statusAll()` | — | `LoopState[]` |
| GET | `/api/status/:id` | `status(id)` | — | `LoopState` |
| GET | `/api/pipes` | `pipes()` | — | `PipeConfig[]` |
| GET | `/api/ui/:id` | (internal map lookup) | — | `JsonRenderSpec \| null` |
| POST | `/api/fork` | `fork(config)` | `{ id, goal, maxIterations, agent? }` | `{ id: string }` |
| POST | `/api/:id/pause` | `send(id, Pause())` | — | `{ ok: true }` |
| POST | `/api/:id/resume` | `send(id, Resume())` | — | `{ ok: true }` |
| POST | `/api/:id/interrupt` | `interrupt(id)` | — | `{ ok: true }` |
| POST | `/api/:id/send` | `send(id, UserMessage)` | `{ text }` | `{ ok: true }` |
| POST | `/api/:id/goal` | `send(id, SetGoal)` | `{ goal }` | `{ ok: true }` |
| POST | `/api/:id/maxiter` | `send(id, SetMaxIterations)` | `{ max }` | `{ ok: true }` |
| POST | `/api/pipe` | `pipe(config)` | `{ from, to, on, strategy }` | `{ ok: true }` |
| POST | `/api/unpipe` | `unpipe(from, to)` | `{ from, to }` | `{ ok: true }` |
| POST | `/api/workflow` | `loadWorkflow + run` | `{ path }` | `{ ok: true }` |
| POST | `/api/ui/:id/emit` | inject UserMessage | `{ event, payload }` | `{ ok: true }` |

#### SSE Endpoint

```
GET /events
```

Uses `streamSSE` from Hono. Subscribes to `PubSub<LoopEvent>` via `orch.subscribe()`.
Each event is serialized as JSON with `event:` type matching the `_tag`:

```
event: Started
data: {"id":"poet","goal":"Write a poem..."}

event: IterationComplete
data: {"id":"poet","iteration":1,"evalResult":"CONTINUE: needs more imagery"}

event: Done
data: {"id":"poet","iterations":3,"result":"...poem text..."}

event: UIUpdate
data: {"id":"poet","spec":{...json-render spec...}}
```

The SSE handler also sends periodic `event: status` heartbeats with `statusAll()` data
so newly connected clients get current state.

#### Agent UI Spec Storage

The server maintains a `Map<string, JsonRenderSpec>` for agent-emitted UI specs.

When processing `IterationComplete` or `Done` events, the server checks the agent output
for `<!-- ui:json {...} -->` markers. If found, it extracts the JSON, validates against
the catalog schemas, stores it, and broadcasts a `UIUpdate` SSE event.

```typescript
const UI_MARKER_REGEX = /<!-- ui:json ([\s\S]*?) -->/
```

#### Serving the Frontend

In development: proxy to Vite dev server (port 5173).
In production: serve `frontend/dist/` as static files.

```typescript
// Dev mode: proxy to Vite
if (process.env.NODE_ENV !== "production") {
  // Use Hono middleware to proxy /src, /@vite, etc. to Vite dev server
}
// Prod mode: serve static
app.use("/*", serveStatic({ root: "./frontend/dist" }))
```

### Server Entry Point (`src/cli-server.ts`)

```typescript
// src/cli-server.ts
// Usage: npx tsx src/cli-server.ts [workflow.prose]
// Starts Hono on localhost:3741
// If workflow.prose is provided, loads and runs it on startup
```

## Part 2: Shared Types (`src/ui-types.ts`)

```typescript
// src/ui-types.ts — Shared types for the dashboard API

/** JSON-render spec emitted by an agent */
export interface JsonRenderSpec {
  readonly root: string
  readonly elements: Record<string, {
    readonly component: string
    readonly props: Record<string, unknown>
    readonly children?: string[]
  }>
}

/** Fork request body */
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

/** Pipe request body */
export interface PipeRequest {
  readonly from: string
  readonly to: string
  readonly on: "iteration" | "done" | "both"
  readonly strategy: "context" | "notify" | "file"
  readonly path?: string  // required if strategy is "file"
}

/** UI emit request body */
export interface UIEmitRequest {
  readonly event: string
  readonly payload?: Record<string, unknown>
}

/** Workflow load request body */
export interface WorkflowRequest {
  readonly path: string
}
```

## Part 3: Frontend Architecture (`frontend/`)

### Project Setup

```bash
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install @json-render/react
npm install @xyflow/react
npm install tailwindcss @tailwindcss/vite
```

Note on AI Elements: Check if `ai-elements` is an npm package. If not, manually implement
the needed components (Message, Tool, Reasoning, CodeBlock) using shadcn/ui primitives.
The key components we need are display-only — message bubbles, code blocks, status badges.

### File Structure

```
frontend/
  index.html
  vite.config.ts
  tailwind.config.ts
  src/
    main.tsx              — React root, mount App
    App.tsx               — Main layout: OrchestratorShell + AgentUISurface
    catalog.ts            — json-render component catalog (Zod schemas + React implementations)
    hooks/
      useOrchestrator.ts  — SSE subscription + REST API hooks
    components/
      OrchestratorShell.tsx  — Left panel: Canvas + EventLog + ControlPanel
      WorkflowCanvas.tsx     — React Flow: nodes=loops, edges=pipes
      EventLog.tsx           — Scrolling event stream (Message-style components)
      ControlPanel.tsx       — Forms: fork, pipe, send, pause/resume/interrupt
      AgentUISurface.tsx     — Right panel: json-render <Renderer> per agent
      AgentCard.tsx          — Card showing agent status, iteration, goal
      MessageBubble.tsx      — Chat-style message display (replacement for AI Elements Message)
      StatusBadge.tsx        — Running/Paused/Done/Failed badge
```

### `useOrchestrator` Hook

Central hook that manages all state and communication:

```typescript
// frontend/src/hooks/useOrchestrator.ts

interface OrchestratorState {
  loops: LoopState[]          // from GET /api/status (periodic) + SSE updates
  pipes: PipeConfig[]         // from GET /api/pipes
  events: LoopEvent[]         // accumulated from SSE stream
  agentUIs: Map<string, JsonRenderSpec>  // from UIUpdate SSE events
  connected: boolean          // SSE connection state
}

interface OrchestratorActions {
  fork(req: ForkRequest): Promise<void>
  pause(id: string): Promise<void>
  resume(id: string): Promise<void>
  interrupt(id: string): Promise<void>
  send(id: string, text: string): Promise<void>
  setGoal(id: string, goal: string): Promise<void>
  addPipe(req: PipeRequest): Promise<void>
  removePipe(from: string, to: string): Promise<void>
  loadWorkflow(path: string): Promise<void>
  emitUIEvent(id: string, event: string, payload?: Record<string, unknown>): Promise<void>
}

export const useOrchestrator = (): OrchestratorState & OrchestratorActions => {
  // 1. Connect to SSE at /events
  // 2. Process events: update loops state, accumulate events, extract UI specs
  // 3. Periodic GET /api/status for full state sync (every 5s)
  // 4. REST calls for actions (POST endpoints)
}
```

### App Layout (`App.tsx`)

Two-column layout:

```
┌────────────────────────────┬──────────────────────────┐
│     Orchestrator Shell     │    Agent UI Surface      │
│                            │                          │
│  ┌──────────────────────┐  │  ┌──────────────────────┐│
│  │  Workflow Canvas      │  │  │  Agent: poet         ││
│  │  (React Flow)         │  │  │  [json-render output]││
│  │                       │  │  └──────────────────────┘│
│  └──────────────────────┘  │  ┌──────────────────────┐│
│                            │  │  Agent: critic        ││
│  ┌──────────────────────┐  │  │  [json-render output]││
│  │  Event Log            │  │  └──────────────────────┘│
│  │  (scrolling stream)   │  │                          │
│  └──────────────────────┘  │  (Empty if no agents     │
│                            │   have emitted UI specs)  │
│  ┌──────────────────────┐  │                          │
│  │  Control Panel        │  │                          │
│  │  [Fork] [Pipe] [Send] │  │                          │
│  └──────────────────────┘  │                          │
└────────────────────────────┴──────────────────────────┘
```

If no agents have emitted UI specs, the right panel shows the event log full-width instead.

### Workflow Canvas (`WorkflowCanvas.tsx`)

Uses `@xyflow/react` (React Flow):

- **Nodes**: One node per loop. Shows: id, status badge, iteration counter, goal (truncated).
  Node color reflects status (green=running, yellow=paused, blue=done, red=failed).
- **Edges**: One edge per pipe. Label shows strategy (context/notify/file) and trigger (iteration/done/both).
  Animated when the source loop is actively running.
- **Auto-layout**: Dagre or simple left-to-right layout. Re-layout when nodes/edges change.
- **Interaction**: Click node → shows detail panel. Double-click → opens send/goal dialog.

### Event Log (`EventLog.tsx`)

Scrolling list of LoopEvent messages, newest at bottom, auto-scrolls:

```
[12:34:01] Started: poet — "Write an original 4-stanza poem..."
[12:34:05] IterationComplete: poet #1 — "CONTINUE: needs more imagery"
[12:34:08] Started: critic — "You are a poetry critic..."
[12:34:12] IterationComplete: critic #1 — "CONTINUE: missing meter analysis"
[12:34:15] Done: poet (3 iterations)
[12:34:18] Done: critic (2 iterations)
```

Each entry is styled with color-coded status and expandable detail.

### Control Panel (`ControlPanel.tsx`)

Tabbed or stacked forms:

**Fork tab**:
- Loop ID (text input)
- Goal (textarea)
- Max iterations (number, default 10)
- Agent personality (textarea, optional)
- Sandbox (select: workspace-write / read-only)
- Model (text input, optional)
- [Fork] button

**Pipe tab**:
- From (select from active loop IDs)
- To (select from active loop IDs)
- Trigger (select: iteration / done / both)
- Strategy (select: context / notify / file)
- Path (text input, shown when strategy=file)
- [Pipe] button

**Send tab**:
- Target (select from active loop IDs)
- Message (textarea)
- [Send] / [Set Goal] / [Pause] / [Resume] / [Interrupt] buttons

**Workflow tab**:
- File path (text input, e.g. `examples/hello-world.prose`)
- [Load & Run] button

### Component Catalog (`frontend/src/catalog.ts`)

The json-render catalog defines what components agents can render. Each component
has a Zod schema (constraining agent output) and a React implementation.

```typescript
import { createCatalog } from "@json-render/react"
import { z } from "zod"

export const catalog = createCatalog({
  // Display components
  AgentCard: {
    schema: z.object({
      id: z.string(),
      status: z.enum(["running", "paused", "done", "failed", "waiting"]),
      iteration: z.number(),
      maxIterations: z.number(),
      goal: z.string()
    }),
    component: AgentCardComponent  // React component
  },

  ProgressBar: {
    schema: z.object({
      value: z.number(),
      max: z.number(),
      label: z.string().optional()
    }),
    component: ProgressBarComponent
  },

  FilePreview: {
    schema: z.object({
      path: z.string(),
      content: z.string(),
      language: z.string().optional()
    }),
    component: FilePreviewComponent
  },

  MetricCard: {
    schema: z.object({
      label: z.string(),
      value: z.string(),
      trend: z.enum(["up", "down", "neutral"]).optional()
    }),
    component: MetricCardComponent
  },

  CodeBlock: {
    schema: z.object({
      language: z.string(),
      code: z.string()
    }),
    component: CodeBlockComponent
  },

  Text: {
    schema: z.object({
      content: z.string(),
      variant: z.enum(["h1", "h2", "h3", "body", "caption"]).optional()
    }),
    component: TextComponent
  },

  // Interactive components (emit events back to agent)
  ActionButton: {
    schema: z.object({
      label: z.string(),
      action: z.string(),
      variant: z.enum(["default", "destructive", "outline"]).optional()
    }),
    component: ActionButtonComponent  // calls emit(action) on click
  },

  // Layout components
  Card: {
    schema: z.object({ title: z.string().optional() }),
    component: CardComponent
  },
  Grid: {
    schema: z.object({ columns: z.number().optional() }),
    component: GridComponent
  },
  Stack: {
    schema: z.object({ direction: z.enum(["horizontal", "vertical"]).optional() }),
    component: StackComponent
  }
})
```

### Agent UI Surface (`AgentUISurface.tsx`)

For each agent that has emitted a UI spec:

```tsx
import { Renderer } from "@json-render/react"
import { catalog } from "../catalog"

const AgentUISurface = ({ agentId, spec, onEmit }) => (
  <div className="border rounded p-4">
    <h3>{agentId}</h3>
    <Renderer
      catalog={catalog}
      spec={spec}
      onEmit={(event, payload) => onEmit(agentId, event, payload)}
    />
  </div>
)
```

## Part 4: Agent UI Emission Protocol

### How Agents Emit UI

Agents include `<!-- ui:json {...} -->` markers in their output. The orchestrator extracts these.

Example agent output:
```
I've analyzed the code and found 3 issues.

<!-- ui:json {
  "root": "card1",
  "elements": {
    "card1": {
      "component": "Card",
      "props": { "title": "Analysis Results" },
      "children": ["metric1", "metric2", "code1"]
    },
    "metric1": {
      "component": "MetricCard",
      "props": { "label": "Issues Found", "value": "3", "trend": "down" }
    },
    "metric2": {
      "component": "MetricCard",
      "props": { "label": "Files Analyzed", "value": "12" }
    },
    "code1": {
      "component": "CodeBlock",
      "props": { "language": "typescript", "code": "// Example fix\nconst x = validate(input)" }
    }
  }
} -->
```

### Extraction Logic (in server.ts)

```typescript
const extractUISpec = (output: string): JsonRenderSpec | null => {
  const match = output.match(UI_MARKER_REGEX)
  if (!match) return null
  try {
    return JSON.parse(match[1]) as JsonRenderSpec
  } catch {
    return null
  }
}
```

### User Event Flow

1. User clicks ActionButton in agent-generated UI
2. json-render calls `emit("button-action", { ... })`
3. Frontend POSTs to `/api/ui/:id/emit` with `{ event: "button-action", payload: { ... } }`
4. Server receives, creates `UserMessage({ text: "UI event: button-action { ... }" })`
5. Sends to agent's queue via `orch.send(id, msg)`
6. Agent processes event in next iteration, can emit updated UI

## Dependencies to Install

### Root package.json (backend)
```bash
npm install hono @hono/node-server
```

### Frontend package.json
```bash
cd frontend
npm install @json-render/react @xyflow/react tailwindcss @tailwindcss/vite zod
```

Note: If `@json-render/react` is not yet published to npm, check the github repo
for installation instructions. It may be `json-render` as a single package.
Same for AI Elements — check `ai-elements` or use the CLI `npx ai-elements@latest add`.

**Fallback**: If json-render or AI Elements packages are not available on npm,
implement the core rendering logic manually:
- json-render → simple recursive JSON-to-React renderer with Zod validation
- AI Elements → hand-built Message/CodeBlock/StatusBadge components with Tailwind

## New Files Summary

```
src/
  server.ts           — Hono HTTP server (REST + SSE + static serving)
  cli-server.ts       — CLI entry: starts server, optionally loads workflow
  ui-types.ts         — Shared types (JsonRenderSpec, request/response shapes)

frontend/
  index.html          — Vite entry
  vite.config.ts      — Vite config (React plugin, Tailwind, proxy to backend)
  tailwind.config.ts  — Tailwind config
  package.json        — Frontend deps
  src/
    main.tsx
    App.tsx
    catalog.ts
    hooks/
      useOrchestrator.ts
    components/
      OrchestratorShell.tsx
      WorkflowCanvas.tsx
      EventLog.tsx
      ControlPanel.tsx
      AgentUISurface.tsx
      AgentCard.tsx
      MessageBubble.tsx
      StatusBadge.tsx
```

## REPL Parity

| REPL Command | API Endpoint | UI Element |
|-------------|-------------|------------|
| `fork <id> <goal>` | POST /api/fork | Fork form in Control Panel |
| `status [id]` | GET /api/status | Workflow Canvas nodes + AgentCards |
| `pause <id>` | POST /api/:id/pause | Pause button on agent node |
| `resume <id>` | POST /api/:id/resume | Resume button on agent node |
| `interrupt <id>` | POST /api/:id/interrupt | Interrupt button on agent node |
| `send <id> <msg>` | POST /api/:id/send | Send form in Control Panel |
| `goal <id> <text>` | POST /api/:id/goal | Goal edit on agent card |
| `maxiter <id> <n>` | POST /api/:id/maxiter | MaxIter edit on agent card |
| `pipe <from> <to> ...` | POST /api/pipe | Pipe form in Control Panel |
| `unpipe <from> <to>` | POST /api/unpipe | Delete edge on Canvas |
| `pipes` | GET /api/pipes | Edges on Workflow Canvas |
| `context <id>` | (in status response) | Context panel (expandable) |
| Event stream | GET /events (SSE) | Event Log component |
| — (new) | GET /api/ui/:id | Agent UI Surface (json-render) |
| — (new) | POST /api/workflow | Load Workflow form |

## Acceptance Criteria

### Server (src/server.ts)
- [ ] All REST endpoints return correct responses (test with curl)
- [ ] SSE /events streams LoopEvent data in real-time
- [ ] SSE reconnection works (client disconnect + reconnect gets current state)
- [ ] Agent UI spec extraction from `<!-- ui:json -->` markers works
- [ ] UIUpdate events broadcast via SSE when agent emits UI
- [ ] POST /api/workflow loads and runs a .prose file
- [ ] POST /api/ui/:id/emit injects UserMessage into agent queue
- [ ] Server provides Effect layers (OrchestratorLive + CodexLLMLive) correctly
- [ ] CORS headers set for dev mode (frontend on different port)

### Frontend (frontend/)
- [ ] Vite dev server starts and serves React app
- [ ] useOrchestrator connects to SSE and updates state in real-time
- [ ] WorkflowCanvas renders nodes for each loop with correct status colors
- [ ] WorkflowCanvas renders edges for each pipe with strategy labels
- [ ] EventLog shows scrolling stream of LoopEvents with timestamps
- [ ] ControlPanel fork form creates a new loop via POST /api/fork
- [ ] ControlPanel pipe form creates a pipe via POST /api/pipe
- [ ] ControlPanel send form sends message via POST /api/:id/send
- [ ] Pause/Resume/Interrupt buttons work on active loops
- [ ] Workflow load form runs a .prose file via POST /api/workflow

### json-render Integration
- [ ] Component catalog with Zod schemas compiles without errors
- [ ] Renderer renders valid JsonRenderSpec as React components
- [ ] Invalid specs are rejected (Zod validation) with graceful error display
- [ ] ActionButton emit() calls POST /api/ui/:id/emit correctly
- [ ] Agent UI Surface updates when UIUpdate SSE event arrives

### End-to-End
- [ ] `npx tsx src/cli-server.ts examples/hello-world.prose` starts server + loads workflow
- [ ] Browser at localhost:3741 shows writer agent node on Canvas
- [ ] Real-time updates: Started → IterationComplete → Done shown in EventLog
- [ ] Fork a second agent from UI, wire a pipe → appears on Canvas
- [ ] Load poetry workshop → two nodes + bidirectional pipe edges
- [ ] TypeScript compiles with zero errors in both root and frontend

### Code Quality
- [ ] No modifications to existing core files (orchestrator.ts, ralph.ts, codex-client.ts, loop-types.ts)
- [ ] All imports use .js extensions (ESM convention)
- [ ] JSDoc headers on new files
- [ ] Error handling on all API endpoints (try/catch + proper HTTP status codes)
- [ ] Frontend accessible (keyboard navigation, aria labels on interactive elements)

## Constraints

- **Do NOT modify** existing files in `src/` (except adding server.ts, cli-server.ts, ui-types.ts)
- **Effect boundary**: HTTP handlers call `Effect.runPromise(...)` at the edge. All orchestrator calls remain Effect-native inside.
- **Import conventions**: All `.ts` imports use `.js` extensions. Frontend uses standard Vite/React imports.
- **Package manager**: npm (not yarn, not pnpm). Root package.json already uses npm.
- **Port**: Backend runs on 3741. Vite dev server on 5173 (default).
- **tsconfig**: Root uses `"module": "nodenext"`, `"moduleResolution": "nodenext"`. Frontend uses Vite defaults.
- **Fallback pattern**: If json-render or AI Elements npm packages don't exist or fail to install, implement equivalent functionality manually. The architecture doesn't change — just the import source.
