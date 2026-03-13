/**
 * WorkflowCanvas.tsx — Loop and pipe overview rendered through @xyflow/react.
 */
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps
} from "@xyflow/react"
import { h, useEffect, useState, useMemo } from "../lib/mini-react.js"
import type { DashboardPipe } from "../hooks/useOrchestrator.js"
import type { LoopState } from "../shared/dashboard-types.js"
import { AgentCard } from "./AgentCard.js"
import { StatusBadge } from "./StatusBadge.js"

const CARD_WIDTH = 280
const CARD_HEIGHT = 196
const H_GAP = 56
const V_GAP = 48
const PADDING = 36

interface WorkflowCanvasProps {
  readonly loops: ReadonlyArray<LoopState>
  readonly pipes: ReadonlyArray<DashboardPipe>
  readonly selectedLoopId: string | null
  readonly onSelectLoop: (id: string | null) => void
  readonly onSendToLoop: (id: string, text: string) => Promise<void>
  readonly onSetGoalForLoop: (id: string, goal: string) => Promise<void>
}

interface PositionedLoop {
  readonly loop: LoopState
  readonly x: number
  readonly y: number
}

interface LoopNodeData {
  readonly loop: LoopState
  readonly selectedLoopId: string | null
  readonly onSelectLoop: (id: string | null) => void
  readonly onOpenActions: (id: string) => void
}

const LoopCardNode = ({
  data,
  selected = false
}: NodeProps<LoopNodeData>): JSX.Element => (
  <AgentCard
    loop={data.loop}
    selected={selected}
    onSelect={(id) => data.onSelectLoop(id)}
    onOpenActions={(id) => data.onOpenActions(id)}
  />
)

export const WorkflowCanvas = ({
  loops,
  pipes,
  selectedLoopId,
  onSelectLoop,
  onSendToLoop,
  onSetGoalForLoop
}: WorkflowCanvasProps): JSX.Element => {
  const layout = useMemo(() => buildLayout(loops), [loops])
  const selectedLoop = loops.find((loop) => loop.id === selectedLoopId) ?? loops[0] ?? null
  const [composerLoopId, setComposerLoopId] = useState<string | null>(null)
  const [composerGoal, setComposerGoal] = useState("")
  const [composerMessage, setComposerMessage] = useState("")
  const composerLoop =
    loops.find((loop) => loop.id === composerLoopId) ??
    loops.find((loop) => loop.id === selectedLoopId) ??
    null

  useEffect(() => {
    if (!composerLoop) {
      return
    }
    setComposerGoal(composerLoop.goal)
    setComposerMessage(composerLoop.lastEvalResult || composerLoop.lastAgentOutput || "")
  }, [composerLoop?.goal, composerLoop?.id, composerLoop?.lastAgentOutput, composerLoop?.lastEvalResult])

  const nodes = useMemo<ReadonlyArray<Node<LoopNodeData>>>(
    () =>
      layout.items.map((item) => ({
        id: item.loop.id,
        type: "loopCard",
        data: {
          loop: item.loop,
          selectedLoopId,
          onSelectLoop,
          onOpenActions: (id) => {
            onSelectLoop(id)
            setComposerLoopId(id)
          }
        },
        position: {
          x: item.x,
          y: item.y
        },
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        selected: item.loop.id === selectedLoopId
      })),
    [layout.items, onSelectLoop, selectedLoopId]
  )

  const loopById = useMemo(
    () => new Map(loops.map((loop) => [loop.id, loop])),
    [loops]
  )

  const edges = useMemo<ReadonlyArray<Edge>>(
    () =>
      pipes.map((pipe) => ({
        id: `${pipe.from}:${pipe.to}:${pipe.on}:${pipe.strategy._tag}`,
        source: pipe.from,
        target: pipe.to,
        label: `${pipe.on} / ${pipeStrategyLabel(pipe.strategy)}`,
        animated: loopById.get(pipe.from)?.status === "running",
        className: `workflow-canvas__path workflow-canvas__path--${pipe.strategy._tag}${
          loopById.get(pipe.from)?.status === "running" ? " workflow-canvas__path--animated" : ""
        }`,
        data: {
          marker: MarkerType.ArrowClosed
        }
      })),
    [loopById, pipes]
  )

  const nodeTypes = useMemo(() => ({ loopCard: LoopCardNode }), [])

  return (
    <section className="workflow-canvas panel">
      <div className="panel__header">
        <div>
          <p className="panel__eyebrow">Canvas</p>
          <h2 className="panel__title">Active loops</h2>
        </div>
        <div className="workflow-canvas__legend" aria-label="Loop status legend">
          <StatusBadge status="running" subtle />
          <StatusBadge status="paused" subtle />
          <StatusBadge status="done" subtle />
          <StatusBadge status="failed" subtle />
        </div>
      </div>

      {loops.length === 0 ? (
        <div className="workflow-canvas__empty">
          <p className="panel__empty">
            No loops are active yet. Fork one from the control panel to populate the
            canvas.
          </p>
        </div>
      ) : (
        <div className="workflow-canvas__surface">
          <div className="workflow-canvas__viewport">
            <ReactFlow
              className="workflow-canvas__reactflow"
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
            >
              <Background className="workflow-canvas__background" />
              <Controls className="workflow-canvas__controls" />
            </ReactFlow>
          </div>
        </div>
      )}

      {pipes.length > 0 ? (
        <div className="workflow-canvas__pipes">
          {pipes.map((pipe) => (
            <div className="workflow-canvas__pipe-pill">
              <strong>{`${pipe.from} -> ${pipe.to}`}</strong>
              <span className="workflow-canvas__pipe-meta">
                {pipe.on} / {pipeStrategyLabel(pipe.strategy)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {selectedLoop ? (
        <aside className="workflow-canvas__detail">
          <div className="workflow-canvas__detail-topline">
            <div>
              <p className="workflow-canvas__detail-eyebrow">Focused loop</p>
              <h3 className="workflow-canvas__detail-title">{selectedLoop.id}</h3>
            </div>
            <StatusBadge status={selectedLoop.status} />
          </div>
          <p className="workflow-canvas__detail-goal">{selectedLoop.goal}</p>
          <div className="workflow-canvas__detail-grid">
            <div>
              <span className="workflow-canvas__detail-label">Thread</span>
              <strong>{selectedLoop.threadId || "Not assigned yet"}</strong>
            </div>
            <div>
              <span className="workflow-canvas__detail-label">Iterations</span>
              <strong>
                {selectedLoop.iteration} / {selectedLoop.maxIterations}
              </strong>
            </div>
          </div>
          {selectedLoop.lastAgentOutput ? (
            <div className="workflow-canvas__detail-block">
              <span className="workflow-canvas__detail-label">Latest output</span>
              <pre className="workflow-canvas__detail-pre">
                <code>{selectedLoop.lastAgentOutput}</code>
              </pre>
            </div>
          ) : null}
          <div className="workflow-canvas__detail-block">
            <span className="workflow-canvas__detail-label">Recent context</span>
            {selectedLoop.context.length === 0 ? (
              <p className="workflow-canvas__context-empty">No context injected yet.</p>
            ) : (
              <ul className="workflow-canvas__context">
                {selectedLoop.context.slice(-4).map((item) => (
                  <li className="workflow-canvas__context-item">
                    <strong>{item.source}</strong>
                    <span>{item.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="workflow-canvas__detail-actions">
            <button
              type="button"
              className="control-button control-button--secondary"
              onClick={() => setComposerLoopId(selectedLoop.id)}
            >
              Open quick actions
            </button>
          </div>
        </aside>
      ) : null}

      {composerLoop ? (
        <div
          className="workflow-canvas__composer-backdrop"
          role="presentation"
          onClick={() => setComposerLoopId(null)}
        >
          <section
            className="workflow-canvas__composer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workflow-canvas-composer-title"
            onClick={(event: Event) => event.stopPropagation()}
          >
            <div className="workflow-canvas__composer-header">
              <div>
                <p className="workflow-canvas__detail-eyebrow">Quick actions</p>
                <h3
                  className="workflow-canvas__detail-title"
                  id="workflow-canvas-composer-title"
                >
                  {composerLoop.id}
                </h3>
              </div>
              <StatusBadge status={composerLoop.status} subtle />
            </div>
            <p className="workflow-canvas__detail-goal">{composerLoop.goal}</p>
            <label className="control-field">
              <span className="control-field__label">Send message</span>
              <textarea
                className="control-textarea"
                rows={4}
                value={composerMessage}
                onInput={(event: Event) =>
                  setComposerMessage((event.currentTarget as HTMLTextAreaElement).value)
                }
              />
            </label>
            <label className="control-field">
              <span className="control-field__label">Set goal</span>
              <textarea
                className="control-textarea"
                rows={4}
                value={composerGoal}
                onInput={(event: Event) =>
                  setComposerGoal((event.currentTarget as HTMLTextAreaElement).value)
                }
              />
            </label>
            <div className="workflow-canvas__composer-actions">
              <button
                type="button"
                className="control-button control-button--secondary"
                onClick={() => {
                  void onSendToLoop(composerLoop.id, composerMessage.trim())
                  setComposerLoopId(null)
                }}
              >
                Send
              </button>
              <button
                type="button"
                className="control-button"
                onClick={() => {
                  void onSetGoalForLoop(composerLoop.id, composerGoal.trim())
                  setComposerLoopId(null)
                }}
              >
                Apply goal
              </button>
              <button
                type="button"
                className="control-button control-button--ghost"
                onClick={() => setComposerLoopId(null)}
              >
                Close
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  )
}

const buildLayout = (loops: ReadonlyArray<LoopState>): {
  readonly items: ReadonlyArray<PositionedLoop>
} => {
  const columns =
    loops.length <= 1 ? 1 : loops.length <= 4 ? 2 : Math.min(3, Math.ceil(Math.sqrt(loops.length)))
  const items = loops.map((loop, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    return {
      loop,
      x: PADDING + column * (CARD_WIDTH + H_GAP),
      y: PADDING + row * (CARD_HEIGHT + V_GAP)
    }
  })

  return { items }
}

const pipeStrategyLabel = (strategy: {
  readonly _tag: string
  readonly maxLength?: number
  readonly path?: string
}): string => {
  switch (strategy._tag) {
    case "context":
      return strategy.maxLength ? `context ${strategy.maxLength}` : "context"
    case "notify":
      return "notify"
    case "file":
      return strategy.path ? `file ${strategy.path}` : "file"
    default:
      return strategy._tag
  }
}
