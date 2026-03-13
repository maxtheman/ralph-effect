/**
 * EventLog.tsx — Event stream panel.
 */
import { h, useEffect, useRef } from "../lib/mini-react.js"
import type { DashboardEventRecord } from "../hooks/useOrchestrator.js"
import { MessageBubble } from "./MessageBubble.js"

export interface EventLogProps {
  readonly events: ReadonlyArray<DashboardEventRecord>
}

export const EventLog = ({ events }: EventLogProps): JSX.Element => {
  const streamRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const node = streamRef.current
    if (node) {
      node.scrollTop = node.scrollHeight
    }
  }, [events.length])

  return (
    <section className="event-log panel">
      <div className="panel__header">
        <div>
          <p className="panel__eyebrow">Event Log</p>
          <h2 className="panel__title">Loop lifecycle</h2>
        </div>
      </div>
      <div className="event-log__stream" ref={streamRef} role="log" aria-live="polite">
        {events.length === 0 ? (
          <p className="panel__empty">
            Events will appear here once the dashboard is connected to the server.
          </p>
        ) : (
          events.slice(-24).map((record) => <MessageBubble record={record} />)
        )}
      </div>
    </section>
  )
}
