/**
 * AgentUISurface.tsx — Right-side area for agent-emitted UIs.
 */
import { Renderer } from "../lib/json-render.js"
import { h } from "../lib/mini-react.js"
import type { JsonRenderSpec, LoopState } from "../shared/dashboard-types.js"
import { formatRelativeTime } from "../lib/dom.js"
import { registry, specToJsonRenderTree } from "../catalog.js"
import { StatusBadge } from "./StatusBadge.js"

export interface AgentUISurfaceProps {
  readonly loops: ReadonlyArray<LoopState>
  readonly agentUIs: ReadonlyMap<string, JsonRenderSpec>
  readonly uiErrors: ReadonlyMap<string, string>
  readonly emitUIEvent: (
    id: string,
    event: string,
    payload?: Record<string, unknown>
  ) => Promise<void>
}

export const createAgentSurfaceLoopIds = (
  loops: ReadonlyArray<LoopState>,
  agentUIs: ReadonlyMap<string, JsonRenderSpec>,
  uiErrors: ReadonlyMap<string, string>
): ReadonlyArray<string> =>
  loops.filter((loop) => agentUIs.has(loop.id) || uiErrors.has(loop.id)).map((loop) => loop.id)

export const AgentUISurface = ({
  loops,
  agentUIs,
  uiErrors,
  emitUIEvent
}: AgentUISurfaceProps): JSX.Element => {
  const visibleLoops = loops.filter((loop) => agentUIs.has(loop.id) || uiErrors.has(loop.id))

  return (
    <section className="agent-surface panel">
      <div className="panel__header">
        <div>
          <p className="panel__eyebrow">Agent UI</p>
          <h2 className="panel__title">Generated surfaces</h2>
        </div>
      </div>

      <div className="agent-surface__stack">
        {visibleLoops.map((loop) => (
          <article className="agent-surface__card">
            <header className="agent-surface__card-header">
              <div>
                <div className="agent-surface__card-id">{loop.id}</div>
                <p className="agent-surface__card-subtitle">
                  Updated {formatRelativeTime(loop.updatedAt)}
                </p>
              </div>
              <StatusBadge status={loop.status} />
            </header>
            <div className="agent-surface__frame">
              {renderSurfaceFrame(loop.id, agentUIs, uiErrors, emitUIEvent)}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

const renderSurfaceFrame = (
  loopId: string,
  agentUIs: ReadonlyMap<string, JsonRenderSpec>,
  uiErrors: ReadonlyMap<string, string>,
  emitUIEvent: AgentUISurfaceProps["emitUIEvent"]
): JSX.Element => {
  const uiError = uiErrors.get(loopId)
  if (uiError) {
    return (
      <div className="agent-surface__error" role="alert">
        {uiError}
      </div>
    )
  }

  const spec = agentUIs.get(loopId)
  if (!spec) {
    return (
      <div className="agent-surface__error" role="alert">
        No json-render UI is available for this loop yet.
      </div>
    )
  }

  try {
    const tree = specToJsonRenderTree(spec)
    return (
      <Renderer
        tree={tree}
        registry={registry}
        onAction={(event, payload) => {
          void emitUIEvent(loopId, event, payload)
        }}
        fallback={(error) => (
          <div className="agent-surface__error" role="alert">
            {error instanceof Error ? error.message : "Invalid json-render tree."}
          </div>
        )}
      />
    )
  } catch (error) {
    return (
      <div className="agent-surface__error" role="alert">
        {error instanceof Error ? error.message : "Invalid json-render tree."}
      </div>
    )
  }
}
