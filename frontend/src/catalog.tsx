/**
 * catalog.tsx — Agent UI catalog using the local json-render surface.
 */
import {
  createCatalog,
  type JsonRenderNode,
  type RendererRegistry,
  type RendererComponentProps
} from "./lib/json-render.js"
import { h } from "./lib/mini-react.js"
import type { JsonRenderSpec } from "./shared/dashboard-types.js"
import { StatusBadge } from "./components/StatusBadge.js"
import { z } from "zod"

interface CatalogComponentProps extends RendererComponentProps {}

const textVariantTag = {
  h1: "h1",
  h2: "h2",
  h3: "h3",
  body: "p",
  caption: "p"
} as const

const AgentCardComponent = ({
  id,
  status,
  iteration,
  maxIterations,
  goal
}: CatalogComponentProps & {
  readonly id: string
  readonly status: "running" | "paused" | "done" | "failed" | "waiting" | "interrupted"
  readonly iteration: number
  readonly maxIterations: number
  readonly goal: string
}) => (
  <article className="json-card json-card--agent">
    <div className="json-card__header">
      <strong className="json-card__eyebrow">{id}</strong>
      <StatusBadge status={status} subtle />
    </div>
    <p className="json-card__title">{goal}</p>
    <div className="json-card__meta">
      <span>Iteration {iteration}</span>
      <span>Max {maxIterations}</span>
    </div>
  </article>
)

const ProgressBarComponent = ({
  value,
  max,
  label
}: CatalogComponentProps & {
  readonly value: number
  readonly max: number
  readonly label?: string
}) => {
  const safeMax = max > 0 ? max : 1
  const percent = Math.max(0, Math.min(100, (value / safeMax) * 100))
  return (
    <div className="json-progress">
      {label ? <div className="json-progress__label">{label}</div> : null}
      <div className="json-progress__track">
        <span className="json-progress__fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="json-progress__meta">
        {value} / {safeMax}
      </div>
    </div>
  )
}

const FilePreviewComponent = ({
  path,
  content,
  language
}: CatalogComponentProps & {
  readonly path: string
  readonly content: string
  readonly language?: string
}) => (
  <figure className="json-code">
    <figcaption className="json-code__label">
      <span>{path}</span>
      {language ? <span>{language}</span> : null}
    </figcaption>
    <pre className="json-code__body">
      <code>{content}</code>
    </pre>
  </figure>
)

const MetricCardComponent = ({
  label,
  value,
  trend
}: CatalogComponentProps & {
  readonly label: string
  readonly value: string
  readonly trend?: "up" | "down" | "neutral"
}) => (
  <article className={`json-card json-card--metric${trend ? ` json-card--${trend}` : ""}`}>
    <span className="json-card__label">{label}</span>
    <strong className="json-card__value">{value}</strong>
    {trend ? <span className="json-card__trend">{trend}</span> : null}
  </article>
)

const CodeBlockComponent = ({
  language,
  code
}: CatalogComponentProps & {
  readonly language?: string
  readonly code: string
}) => (
  <figure className="json-code">
    {language ? <figcaption className="json-code__label">{language}</figcaption> : null}
    <pre className="json-code__body">
      <code>{code}</code>
    </pre>
  </figure>
)

const TextComponent = ({
  content,
  variant = "body"
}: CatalogComponentProps & {
  readonly content: string
  readonly variant?: "h1" | "h2" | "h3" | "body" | "caption"
}) => {
  const Tag = textVariantTag[variant]
  return <Tag className={`json-text json-text--${variant}`}>{content}</Tag>
}

const ActionButtonComponent = ({
  label,
  action,
  payload,
  variant = "default",
  emit
}: CatalogComponentProps & {
  readonly label: string
  readonly action: string
  readonly payload?: Record<string, unknown>
  readonly variant?: "default" | "destructive" | "outline"
}) => (
  <button
    type="button"
    className={`json-button json-button--${variant}`}
    onClick={() => emit?.(action, payload)}
  >
    {label}
  </button>
)

const CardComponent = ({
  title,
  subtitle,
  tone = "neutral",
  children
}: CatalogComponentProps & {
  readonly title?: string
  readonly subtitle?: string
  readonly tone?: "neutral" | "accent" | "success" | "warning" | "danger"
}) => (
  <section className={`json-card json-card--panel json-card--${tone}`}>
    {title || subtitle ? (
      <header className="json-card__header">
        {title ? <h3 className="json-card__title">{title}</h3> : null}
        {subtitle ? <p className="json-card__subtitle">{subtitle}</p> : null}
      </header>
    ) : null}
    <div className="json-card__body">{children ?? []}</div>
  </section>
)

const GridComponent = ({
  columns = 2,
  children
}: CatalogComponentProps & {
  readonly columns?: number
}) => (
  <div
    className="json-grid"
    style={{ gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 1fr))` }}
  >
    {children ?? []}
  </div>
)

const StackComponent = ({
  direction = "vertical",
  title,
  children
}: CatalogComponentProps & {
  readonly direction?: "horizontal" | "vertical"
  readonly title?: string
}) => (
  <section className="json-stack-frame">
    {title ? <h4 className="json-stack-frame__title">{title}</h4> : null}
    <div className={`json-stack json-stack--${direction}`}>{children ?? []}</div>
  </section>
)

const LegacyTextComponent = ({
  text,
  size = "md",
  tone = "body"
}: CatalogComponentProps & {
  readonly text: string
  readonly size?: "sm" | "md" | "lg"
  readonly tone?: "body" | "muted" | "accent"
}) => {
  const variant = size === "lg" ? "h3" : size === "sm" ? "caption" : "body"
  return (
    <p className={`json-text json-text--${variant} json-text--tone-${tone}`}>
      {text}
    </p>
  )
}

const LegacyMetricComponent = ({
  label,
  value
}: CatalogComponentProps & {
  readonly label: string
  readonly value: string | number
}) => <MetricCardComponent label={label} value={String(value)} />

const LegacyButtonComponent = ({
  label,
  event,
  payload,
  variant = "primary",
  emit
}: CatalogComponentProps & {
  readonly label: string
  readonly event: string
  readonly payload?: Record<string, unknown>
  readonly variant?: "primary" | "secondary" | "ghost"
}) => (
  <button
    type="button"
    className={`json-button json-button--legacy-${variant}`}
    onClick={() => emit?.(event, payload)}
  >
    {label}
  </button>
)

const ListComponent = ({
  items,
  ordered = false
}: CatalogComponentProps & {
  readonly items: ReadonlyArray<string>
  readonly ordered?: boolean
}) => {
  const Tag = ordered ? "ol" : "ul"
  return (
    <Tag className="json-list">
      {items.map((item) => (
        <li>{item}</li>
      ))}
    </Tag>
  )
}

const StatusComponent = ({
  label,
  tone = "neutral"
}: CatalogComponentProps & {
  readonly label: string
  readonly tone?: "neutral" | "accent" | "success" | "warning" | "danger"
}) => <span className={`json-status json-status--${tone}`}>{label}</span>

export const catalog = createCatalog({
  components: {
    AgentCard: {
      props: z.object({
        id: z.string(),
        status: z.enum(["running", "paused", "done", "failed", "waiting", "interrupted"]),
        iteration: z.number(),
        maxIterations: z.number(),
        goal: z.string()
      })
    },
    ProgressBar: {
      props: z.object({
        value: z.number(),
        max: z.number(),
        label: z.string().optional()
      })
    },
    FilePreview: {
      props: z.object({
        path: z.string(),
        content: z.string(),
        language: z.string().optional()
      })
    },
    MetricCard: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        trend: z.enum(["up", "down", "neutral"]).optional()
      })
    },
    CodeBlock: {
      props: z.object({
        language: z.string().optional(),
        code: z.string()
      })
    },
    Text: {
      props: z.object({
        content: z.string(),
        variant: z.enum(["h1", "h2", "h3", "body", "caption"]).optional()
      })
    },
    ActionButton: {
      props: z.object({
        label: z.string(),
        action: z.string(),
        payload: z.record(z.unknown()).optional(),
        variant: z.enum(["default", "destructive", "outline"]).optional()
      })
    },
    Card: {
      props: z.object({
        title: z.string().optional(),
        subtitle: z.string().optional(),
        tone: z.enum(["neutral", "accent", "success", "warning", "danger"]).optional()
      }),
      hasChildren: true
    },
    Grid: {
      props: z.object({
        columns: z.number().optional()
      }),
      hasChildren: true
    },
    Stack: {
      props: z.object({
        direction: z.enum(["horizontal", "vertical"]).optional(),
        title: z.string().optional()
      }),
      hasChildren: true
    },
    stack: {
      props: z.object({
        direction: z.enum(["horizontal", "vertical"]).optional(),
        title: z.string().optional()
      }),
      hasChildren: true
    },
    panel: {
      props: z.object({
        title: z.string().optional(),
        subtitle: z.string().optional(),
        tone: z.enum(["neutral", "accent", "success", "warning", "danger"]).optional()
      }),
      hasChildren: true
    },
    text: {
      props: z.object({
        text: z.string(),
        size: z.enum(["sm", "md", "lg"]).optional(),
        tone: z.enum(["body", "muted", "accent"]).optional()
      })
    },
    metric: {
      props: z.object({
        label: z.string(),
        value: z.union([z.string(), z.number()])
      })
    },
    button: {
      props: z.object({
        label: z.string(),
        event: z.string(),
        payload: z.record(z.unknown()).optional(),
        variant: z.enum(["primary", "secondary", "ghost"]).optional()
      })
    },
    code: {
      props: z.object({
        code: z.string(),
        language: z.string().optional()
      })
    },
    list: {
      props: z.object({
        items: z.array(z.string()),
        ordered: z.boolean().optional()
      })
    },
    status: {
      props: z.object({
        label: z.string(),
        tone: z.enum(["neutral", "accent", "success", "warning", "danger"]).optional()
      })
    },
    grid: {
      props: z.object({
        columns: z.number().optional()
      }),
      hasChildren: true
    }
  },
  actions: {
    emitUIEvent: {
      props: z.object({
        event: z.string(),
        payload: z.record(z.unknown()).optional()
      })
    }
  }
})

export const registry = {
  AgentCard: AgentCardComponent,
  ProgressBar: ProgressBarComponent,
  FilePreview: FilePreviewComponent,
  MetricCard: MetricCardComponent,
  CodeBlock: CodeBlockComponent,
  Text: TextComponent,
  ActionButton: ActionButtonComponent,
  Card: CardComponent,
  Grid: GridComponent,
  Stack: StackComponent,
  stack: StackComponent,
  panel: CardComponent,
  text: LegacyTextComponent,
  metric: LegacyMetricComponent,
  button: LegacyButtonComponent,
  code: CodeBlockComponent,
  list: ListComponent,
  status: StatusComponent,
  grid: GridComponent
} satisfies RendererRegistry

export const specToJsonRenderTree = (spec: JsonRenderSpec): JsonRenderNode =>
  renderSpecNode(spec.root, spec, new Set<string>())

const renderSpecNode = (
  id: string,
  spec: JsonRenderSpec,
  lineage: Set<string>
): JsonRenderNode => {
  if (lineage.has(id)) {
    throw new Error(`Recursive json-render tree detected at "${id}".`)
  }

  const element = spec.elements[id]
  if (!element) {
    throw new Error(`Missing json-render element "${id}".`)
  }

  const definitions = catalog.components as Record<
    string,
    { readonly props?: { parse: (value: unknown) => Record<string, unknown> } }
  >
  const definition = definitions[element.component]
  if (!definition) {
    throw new Error(`Unsupported component "${element.component}".`)
  }

  return {
    key: id,
    type: element.component,
    props: definition.props ? definition.props.parse(element.props) : element.props,
    children: (element.children ?? []).map((childId) =>
      renderSpecNode(childId, spec, new Set([...lineage, id]))
    )
  }
}
