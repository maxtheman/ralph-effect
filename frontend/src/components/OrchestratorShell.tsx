/**
 * OrchestratorShell.tsx — Left-side operational shell.
 */
import { h } from "../lib/mini-react.js"
import type { OrchestratorModel } from "../hooks/useOrchestrator.js"
import { ControlPanel } from "./ControlPanel.js"
import { EventLog } from "./EventLog.js"
import { WorkflowCanvas } from "./WorkflowCanvas.js"

export const OrchestratorShell = ({
  orchestrator
}: {
  readonly orchestrator: OrchestratorModel
}): JSX.Element => (
  <section className="orchestrator-shell">
    <WorkflowCanvas
      loops={orchestrator.loops}
      pipes={orchestrator.pipes}
      selectedLoopId={orchestrator.selectedLoopId}
      onSelectLoop={orchestrator.selectLoop}
      onSendToLoop={orchestrator.send}
      onSetGoalForLoop={orchestrator.setGoal}
    />
    <EventLog events={orchestrator.events} />
    <ControlPanel orchestrator={orchestrator} />
  </section>
)
