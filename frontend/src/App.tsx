/**
 * App.tsx — Dashboard application shell.
 */
import { h, useMemo } from "./lib/mini-react.js"
import { createAgentSurfaceLoopIds } from "./components/AgentUISurface.js"
import { AgentUISurface } from "./components/AgentUISurface.js"
import { OrchestratorShell } from "./components/OrchestratorShell.js"
import { useOrchestrator } from "./hooks/useOrchestrator.js"

export const App = (): JSX.Element => {
  const orchestrator = useOrchestrator()
  const visibleSurfaceIds = useMemo(
    () =>
      createAgentSurfaceLoopIds(
        orchestrator.loops,
        orchestrator.agentUIs,
        orchestrator.uiErrors
      ),
    [orchestrator.loops, orchestrator.agentUIs, orchestrator.uiErrors]
  )

  const heroNote = orchestrator.error
    ? orchestrator.error
    : orchestrator.connected
      ? "Streaming orchestrator events and UI updates from /events."
      : "Connect the backend on port 3741 to stream live state."

  return (
    <main className="dashboard">
      <header className="dashboard__hero">
        <div className="dashboard__hero-topline">
          <p className="dashboard__eyebrow">Ralph Effect</p>
          <span
            className={`dashboard__connection dashboard__connection--${
              orchestrator.connected ? "live" : "offline"
            }`}
            role="status"
            aria-live="polite"
          >
            {orchestrator.connected ? "Live" : "Offline"}
          </span>
        </div>
        <div className="dashboard__hero-grid">
          <div>
            <h1 className="dashboard__title">Dynamic Agent Dashboard</h1>
            <p className="dashboard__lede">
              A browser control surface for loop orchestration, real-time event
              playback, and agent-generated interfaces.
            </p>
            <p className="dashboard__note">{heroNote}</p>
          </div>
          <div className="dashboard__facts" aria-label="Dashboard summary">
            <div className="dashboard__fact">
              <strong className="dashboard__fact-value">{orchestrator.loops.length}</strong>
              <span className="dashboard__fact-label">Loops</span>
            </div>
            <div className="dashboard__fact">
              <strong className="dashboard__fact-value">{orchestrator.pipes.length}</strong>
              <span className="dashboard__fact-label">Pipes</span>
            </div>
            <div className="dashboard__fact">
              <strong className="dashboard__fact-value">{orchestrator.events.length}</strong>
              <span className="dashboard__fact-label">Events</span>
            </div>
          </div>
        </div>
      </header>

      <div
        className={`dashboard__layout${
          visibleSurfaceIds.length === 0 ? " dashboard__layout--solo" : ""
        }`}
      >
        <OrchestratorShell orchestrator={orchestrator} />
        {visibleSurfaceIds.length > 0 ? (
          <AgentUISurface
            loops={orchestrator.loops}
            agentUIs={orchestrator.agentUIs}
            uiErrors={orchestrator.uiErrors}
            emitUIEvent={orchestrator.emitUIEvent}
          />
        ) : null}
      </div>
    </main>
  )
}
