/**
 * AgentCard.tsx — Compact loop summary card.
 */
import { h } from "../lib/mini-react.js"
import type { LoopState } from "../shared/dashboard-types.js"
import { formatRelativeTime } from "../lib/dom.js"
import { StatusBadge } from "./StatusBadge.js"

export interface AgentCardProps {
  readonly loop: LoopState
  readonly selected?: boolean
  readonly onSelect?: (id: string) => void
  readonly onOpenActions?: (id: string) => void
}

const shorten = (text: string): string => {
  if (text.length <= 148) return text
  return `${text.slice(0, 145)}...`
}

export const AgentCard = ({
  loop,
  selected = false,
  onSelect,
  onOpenActions
}: AgentCardProps): JSX.Element => (
  <button
    type="button"
    className={`agent-card${selected ? " agent-card--selected" : ""}`}
    data-loop-id={loop.id}
    aria-pressed={selected}
    onClick={() => onSelect?.(loop.id)}
    onDoubleClick={() => onOpenActions?.(loop.id)}
  >
    <header className="agent-card__header">
      <div>
        <div className="agent-card__eyebrow">{loop.id}</div>
        <h3 className="agent-card__title">{loop.goal}</h3>
      </div>
      <StatusBadge status={loop.status} />
    </header>

    {loop.lastEvalResult ? (
      <p className="agent-card__summary">{shorten(loop.lastEvalResult)}</p>
    ) : (
      <p className="agent-card__summary agent-card__summary--muted">
        Awaiting evaluation output.
      </p>
    )}

    <dl className="agent-card__metrics">
      <div className="agent-card__metric">
        <dt>Iteration</dt>
        <dd>{loop.iteration}</dd>
      </div>
      <div className="agent-card__metric">
        <dt>Max</dt>
        <dd>{loop.maxIterations}</dd>
      </div>
      <div className="agent-card__metric">
        <dt>Updated</dt>
        <dd>{formatRelativeTime(loop.updatedAt)}</dd>
      </div>
    </dl>

    {loop.lastAgentOutput ? (
      <p className="agent-card__output">{shorten(loop.lastAgentOutput)}</p>
    ) : null}

    <span className="agent-card__hint">Click to focus. Double-click for quick send and goal.</span>
  </button>
)
