/**
 * MessageBubble.tsx — Event log item.
 */
import { h } from "../lib/mini-react.js"
import type { DashboardEventRecord } from "../hooks/useOrchestrator.js"
import { formatTimestamp } from "../lib/dom.js"

const summarizeEvent = (record: DashboardEventRecord): { title: string; detail: string } => {
  const { payload } = record
  switch (payload._tag) {
    case "Started":
      return {
        title: `${payload.id} started`,
        detail: payload.goal
      }
    case "IterationComplete":
      return {
        title: `${payload.id} finished iteration ${payload.iteration}`,
        detail: payload.evalResult
      }
    case "Done":
      return {
        title: `${payload.id} completed`,
        detail: payload.result
      }
    case "Failed":
      return {
        title: `${payload.id} failed`,
        detail: payload.error
      }
    case "Interrupted":
      return {
        title: `${payload.id} interrupted`,
        detail: "Execution was interrupted from the dashboard."
      }
    case "UIUpdate":
      return {
        title: `${payload.id} published a UI update`,
        detail: `Root node: ${payload.spec.root}`
      }
    case "status":
      return {
        title: "Status heartbeat",
        detail: `${payload.loops.length} loop${payload.loops.length === 1 ? "" : "s"} synchronized`
      }
  }
}

export const MessageBubble = ({ record }: { readonly record: DashboardEventRecord }): JSX.Element => {
  const summary = summarizeEvent(record)
  return (
    <article className={`message-bubble message-bubble--${record.payload._tag.toLowerCase()}`}>
      <header className="message-bubble__header">
        <strong>{summary.title}</strong>
        <time>{formatTimestamp(record.receivedAt)}</time>
      </header>
      <p className="message-bubble__summary">{summary.detail}</p>
      <details className="message-bubble__details">
        <summary>Payload</summary>
        <pre className="message-bubble__body">
          <code>{JSON.stringify(record.payload, null, 2)}</code>
        </pre>
      </details>
    </article>
  )
}
