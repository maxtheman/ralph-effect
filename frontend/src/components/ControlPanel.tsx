/**
 * ControlPanel.tsx — Dashboard controls for loop actions.
 */
import { h, useEffect, useState } from "../lib/mini-react.js"
import type { OrchestratorModel } from "../hooks/useOrchestrator.js"

interface ControlPanelProps {
  readonly orchestrator: OrchestratorModel
}

type NoticeTone = "neutral" | "success" | "error"

export const ControlPanel = ({ orchestrator }: ControlPanelProps): JSX.Element => {
  const [notice, setNotice] = useState<{
    readonly tone: NoticeTone
    readonly text: string
  }>({
    tone: "neutral",
    text: "Dashboard controls mirror the existing REPL commands."
  })

  const [forkId, setForkId] = useState("critic")
  const [forkGoal, setForkGoal] = useState(
    "Review the latest output and propose the next corrective action."
  )
  const [forkIterations, setForkIterations] = useState("5")
  const [forkPersonality, setForkPersonality] = useState("")
  const [forkSandbox, setForkSandbox] = useState<"workspace-write" | "read-only">(
    "workspace-write"
  )
  const [forkModel, setForkModel] = useState("")
  const [forkReasoning, setForkReasoning] = useState<"low" | "medium" | "high">("medium")

  const [goalText, setGoalText] = useState("")
  const [maxIterations, setMaxIterations] = useState("5")
  const [pipeFrom, setPipeFrom] = useState("")
  const [pipeTo, setPipeTo] = useState("")
  const [pipeTrigger, setPipeTrigger] = useState<"iteration" | "done" | "both">("iteration")
  const [pipeStrategy, setPipeStrategy] = useState<"context" | "notify" | "file">("context")
  const [pipePath, setPipePath] = useState("examples/shared-output.md")
  const [pipeMaxLength, setPipeMaxLength] = useState("4000")
  const [sendTarget, setSendTarget] = useState("")
  const [sendText, setSendText] = useState(
    "Tighten the second stanza and increase the image contrast."
  )
  const [workflowPath, setWorkflowPath] = useState("examples/hello-world.prose")

  const loopIdsKey = orchestrator.loops.map((loop) => loop.id).join("|")

  useEffect(() => {
    const firstLoop = orchestrator.selectedLoopId ?? orchestrator.loops[0]?.id ?? ""
    const loopIds = new Set(orchestrator.loops.map((loop) => loop.id))

    if ((!sendTarget || !loopIds.has(sendTarget)) && firstLoop) {
      setSendTarget(firstLoop)
    }
    if ((!pipeFrom || !loopIds.has(pipeFrom)) && firstLoop) {
      setPipeFrom(firstLoop)
    }
    if ((!pipeTo || !loopIds.has(pipeTo)) && orchestrator.loops[1]?.id) {
      setPipeTo(orchestrator.loops[1].id)
    } else if ((!pipeTo || !loopIds.has(pipeTo)) && firstLoop) {
      setPipeTo(firstLoop)
    }
    if (orchestrator.selectedLoopId && !goalText) {
      const active = orchestrator.loops.find((loop) => loop.id === orchestrator.selectedLoopId)
      if (active) {
        setGoalText(active.goal)
        setMaxIterations(String(active.maxIterations))
      }
    }
  }, [loopIdsKey, orchestrator.selectedLoopId])

  const activeLoop =
    orchestrator.loops.find((loop) => loop.id === orchestrator.selectedLoopId) ?? null

  const runAction = async (
    successMessage: string,
    task: () => Promise<void>
  ): Promise<void> => {
    try {
      await task()
      setNotice({ tone: "success", text: successMessage })
    } catch (error) {
      setNotice({ tone: "error", text: describeError(error) })
    }
  }

  return (
    <section className="control-panel panel">
      <div className="panel__header">
        <div>
          <p className="panel__eyebrow">Controls</p>
          <h2 className="panel__title">Orchestrate loops</h2>
        </div>
      </div>

      <p className={`control-panel__notice control-panel__notice--${notice.tone}`}>
        {notice.text}
      </p>

      <div className="control-panel__stack">
        <section className="control-form">
          <div className="control-form__header">
            <h3 className="control-form__title">Selected loop</h3>
            {activeLoop ? <span className="control-form__subtitle">{activeLoop.id}</span> : null}
          </div>

          <Field label="Focus loop">
            <select
              className="control-select"
              value={orchestrator.selectedLoopId ?? ""}
              onChange={(event: Event) =>
                orchestrator.selectLoop((event.currentTarget as HTMLSelectElement).value || null)
              }
            >
              <option value="">Choose a loop</option>
              {orchestrator.loops.map((loop) => (
                <option value={loop.id}>{loop.id}</option>
              ))}
            </select>
          </Field>

          <div className="control-actions">
            <button
              type="button"
              className="control-button control-button--secondary"
              onClick={() =>
                void runAction("Paused selected loop.", async () => {
                  if (!orchestrator.selectedLoopId) {
                    throw new Error("Choose a loop first.")
                  }
                  await orchestrator.pause(orchestrator.selectedLoopId)
                })
              }
            >
              Pause
            </button>
            <button
              type="button"
              className="control-button control-button--secondary"
              onClick={() =>
                void runAction("Resumed selected loop.", async () => {
                  if (!orchestrator.selectedLoopId) {
                    throw new Error("Choose a loop first.")
                  }
                  await orchestrator.resume(orchestrator.selectedLoopId)
                })
              }
            >
              Resume
            </button>
            <button
              type="button"
              className="control-button control-button--danger"
              onClick={() =>
                void runAction("Interrupted selected loop.", async () => {
                  if (!orchestrator.selectedLoopId) {
                    throw new Error("Choose a loop first.")
                  }
                  await orchestrator.interrupt(orchestrator.selectedLoopId)
                })
              }
            >
              Interrupt
            </button>
          </div>

          <Field label="Set goal">
            <textarea
              className="control-textarea"
              rows={3}
              value={goalText}
              onInput={(event: Event) =>
                setGoalText((event.currentTarget as HTMLTextAreaElement).value)
              }
            />
          </Field>
          <button
            type="button"
            className="control-button"
            onClick={() =>
              void runAction("Updated loop goal.", async () => {
                if (!orchestrator.selectedLoopId || !goalText.trim()) {
                  throw new Error("Choose a loop and enter a goal.")
                }
                await orchestrator.setGoal(orchestrator.selectedLoopId, goalText.trim())
              })
            }
          >
            Apply goal
          </button>

          <Field label="Set max iterations">
            <input
              className="control-input"
              type="number"
              min="1"
              step="1"
              value={maxIterations}
              onInput={(event: Event) =>
                setMaxIterations((event.currentTarget as HTMLInputElement).value)
              }
            />
          </Field>
          <button
            type="button"
            className="control-button control-button--secondary"
            onClick={() =>
              void runAction("Updated max iterations.", async () => {
                const nextMax = Number(maxIterations)
                if (!orchestrator.selectedLoopId || !Number.isFinite(nextMax) || nextMax < 1) {
                  throw new Error("Choose a loop and provide a valid max iteration count.")
                }
                await orchestrator.setMaxIterations(orchestrator.selectedLoopId, nextMax)
              })
            }
          >
            Apply max
          </button>
        </section>

        <form
          className="control-form"
          onSubmit={(event: Event) => {
            event.preventDefault()
            void runAction(`Forked ${forkId.trim()}.`, async () => {
              if (!forkId.trim() || !forkGoal.trim()) {
                throw new Error("Loop id and goal are required.")
              }
              const max = Number(forkIterations)
              await orchestrator.fork({
                id: forkId.trim(),
                goal: forkGoal.trim(),
                maxIterations: Number.isFinite(max) && max > 0 ? max : undefined,
                agent: {
                  personality: forkPersonality.trim() || undefined,
                  sandbox: forkSandbox,
                  model: forkModel.trim() || undefined,
                  reasoningEffort: forkReasoning
                }
              })
            })
          }}
        >
          <div className="control-form__header">
            <h3 className="control-form__title">Fork loop</h3>
            <span className="control-form__subtitle">POST /api/fork</span>
          </div>

          <Field label="Loop id">
            <input
              className="control-input"
              value={forkId}
              onInput={(event: Event) => setForkId((event.currentTarget as HTMLInputElement).value)}
            />
          </Field>
          <Field label="Goal">
            <textarea
              className="control-textarea"
              rows={4}
              value={forkGoal}
              onInput={(event: Event) =>
                setForkGoal((event.currentTarget as HTMLTextAreaElement).value)
              }
            />
          </Field>
          <div className="control-grid">
            <Field label="Max iterations">
              <input
                className="control-input"
                type="number"
                min="1"
                step="1"
                value={forkIterations}
                onInput={(event: Event) =>
                  setForkIterations((event.currentTarget as HTMLInputElement).value)
                }
              />
            </Field>
            <Field label="Sandbox">
              <select
                className="control-select"
                value={forkSandbox}
                onChange={(event: Event) =>
                  setForkSandbox(
                    (event.currentTarget as HTMLSelectElement).value as
                      | "workspace-write"
                      | "read-only"
                  )
                }
              >
                <option value="workspace-write">workspace-write</option>
                <option value="read-only">read-only</option>
              </select>
            </Field>
          </div>
          <div className="control-grid">
            <Field label="Model">
              <input
                className="control-input"
                placeholder="gpt-5, codex, ..."
                value={forkModel}
                onInput={(event: Event) =>
                  setForkModel((event.currentTarget as HTMLInputElement).value)
                }
              />
            </Field>
            <Field label="Reasoning">
              <select
                className="control-select"
                value={forkReasoning}
                onChange={(event: Event) =>
                  setForkReasoning(
                    (event.currentTarget as HTMLSelectElement).value as
                      | "low"
                      | "medium"
                      | "high"
                  )
                }
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </Field>
          </div>
          <Field label="Personality">
            <textarea
              className="control-textarea"
              rows={3}
              placeholder="Optional persona override for the new loop."
              value={forkPersonality}
              onInput={(event: Event) =>
                setForkPersonality((event.currentTarget as HTMLTextAreaElement).value)
              }
            />
          </Field>
          <button type="submit" className="control-button">
            Fork loop
          </button>
        </form>

        <form
          className="control-form"
          onSubmit={(event: Event) => {
            event.preventDefault()
            void runAction("Added pipe.", async () => {
              if (!pipeFrom || !pipeTo) {
                throw new Error("Choose source and target loops first.")
              }
              await orchestrator.addPipe({
                from: pipeFrom,
                to: pipeTo,
                on: pipeTrigger,
                strategy: pipeStrategy,
                path: pipeStrategy === "file" ? pipePath.trim() : undefined,
                maxLength:
                  pipeStrategy === "context" && Number.isFinite(Number(pipeMaxLength))
                    ? Number(pipeMaxLength)
                    : undefined
              })
            })
          }}
        >
          <div className="control-form__header">
            <h3 className="control-form__title">Wire pipe</h3>
            <span className="control-form__subtitle">POST /api/pipe</span>
          </div>

          <div className="control-grid">
            <Field label="From">
              <select
                className="control-select"
                value={pipeFrom}
                onChange={(event: Event) =>
                  setPipeFrom((event.currentTarget as HTMLSelectElement).value)
                }
              >
                <option value="">Choose a loop</option>
                {orchestrator.loops.map((loop) => (
                  <option value={loop.id}>{loop.id}</option>
                ))}
              </select>
            </Field>
            <Field label="To">
              <select
                className="control-select"
                value={pipeTo}
                onChange={(event: Event) =>
                  setPipeTo((event.currentTarget as HTMLSelectElement).value)
                }
              >
                <option value="">Choose a loop</option>
                {orchestrator.loops.map((loop) => (
                  <option value={loop.id}>{loop.id}</option>
                ))}
              </select>
            </Field>
          </div>

          <div className="control-grid">
            <Field label="Trigger">
              <select
                className="control-select"
                value={pipeTrigger}
                onChange={(event: Event) =>
                  setPipeTrigger(
                    (event.currentTarget as HTMLSelectElement).value as
                      | "iteration"
                      | "done"
                      | "both"
                  )
                }
              >
                <option value="iteration">iteration</option>
                <option value="done">done</option>
                <option value="both">both</option>
              </select>
            </Field>
            <Field label="Strategy">
              <select
                className="control-select"
                value={pipeStrategy}
                onChange={(event: Event) =>
                  setPipeStrategy(
                    (event.currentTarget as HTMLSelectElement).value as
                      | "context"
                      | "notify"
                      | "file"
                  )
                }
              >
                <option value="context">context</option>
                <option value="notify">notify</option>
                <option value="file">file</option>
              </select>
            </Field>
          </div>

          {pipeStrategy === "context" ? (
            <Field label="Context max length">
              <input
                className="control-input"
                type="number"
                min="1"
                step="1"
                value={pipeMaxLength}
                onInput={(event: Event) =>
                  setPipeMaxLength((event.currentTarget as HTMLInputElement).value)
                }
              />
            </Field>
          ) : null}

          {pipeStrategy === "file" ? (
            <Field label="File path">
              <input
                className="control-input"
                value={pipePath}
                onInput={(event: Event) =>
                  setPipePath((event.currentTarget as HTMLInputElement).value)
                }
              />
            </Field>
          ) : null}

          <div className="control-actions">
            <button type="submit" className="control-button">
              Add pipe
            </button>
            <button
              type="button"
              className="control-button control-button--ghost"
              onClick={() =>
                void runAction("Removed pipe.", async () => {
                  if (!pipeFrom || !pipeTo) {
                    throw new Error("Choose source and target loops first.")
                  }
                  await orchestrator.removePipe(pipeFrom, pipeTo)
                })
              }
            >
              Remove selected pipe
            </button>
          </div>
        </form>

        <form
          className="control-form"
          onSubmit={(event: Event) => {
            event.preventDefault()
            void runAction("Sent message.", async () => {
              if (!sendTarget || !sendText.trim()) {
                throw new Error("Choose a loop and enter a message.")
              }
              await orchestrator.send(sendTarget, sendText.trim())
              setSendText("")
            })
          }}
        >
          <div className="control-form__header">
            <h3 className="control-form__title">Send message</h3>
            <span className="control-form__subtitle">POST /api/:id/send</span>
          </div>
          <Field label="Loop">
            <select
              className="control-select"
              value={sendTarget}
              onChange={(event: Event) =>
                setSendTarget((event.currentTarget as HTMLSelectElement).value)
              }
            >
              <option value="">Choose a loop</option>
              {orchestrator.loops.map((loop) => (
                <option value={loop.id}>{loop.id}</option>
              ))}
            </select>
          </Field>
          <Field label="Message">
            <textarea
              className="control-textarea"
              rows={4}
              value={sendText}
              onInput={(event: Event) =>
                setSendText((event.currentTarget as HTMLTextAreaElement).value)
              }
            />
          </Field>
          <button type="submit" className="control-button">
            Send message
          </button>
        </form>

        <form
          className="control-form"
          onSubmit={(event: Event) => {
            event.preventDefault()
            void runAction(`Loaded workflow ${workflowPath}.`, async () => {
              if (!workflowPath.trim()) {
                throw new Error("Workflow path is required.")
              }
              await orchestrator.loadWorkflow({ path: workflowPath.trim() })
            })
          }}
        >
          <div className="control-form__header">
            <h3 className="control-form__title">Load workflow</h3>
            <span className="control-form__subtitle">POST /api/workflow</span>
          </div>
          <Field label="Workflow path">
            <input
              className="control-input"
              value={workflowPath}
              onInput={(event: Event) =>
                setWorkflowPath((event.currentTarget as HTMLInputElement).value)
              }
            />
          </Field>
          <button type="submit" className="control-button control-button--secondary">
            Load and run
          </button>
        </form>
      </div>
    </section>
  )
}

const Field = ({
  label,
  children
}: {
  readonly label: string
  readonly children: JSX.Element
}): JSX.Element => (
  <label className="control-field">
    <span className="control-field__label">{label}</span>
    {children}
  </label>
)

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown dashboard error"
