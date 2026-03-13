/**
 * StatusBadge.tsx — Visual status chip for loop state.
 */
import { h } from "../lib/mini-react.js"
import type { LoopStatus } from "../shared/dashboard-types.js"

export interface StatusBadgeProps {
  readonly status: LoopStatus
  readonly subtle?: boolean
}

export const StatusBadge = ({
  status,
  subtle = false
}: StatusBadgeProps): JSX.Element => (
  <span
    className={`status-badge status-badge--${status}${
      subtle ? " status-badge--subtle" : ""
    }`}
    data-status={status}
  >
    {status}
  </span>
)
