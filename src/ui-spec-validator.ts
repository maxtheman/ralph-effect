/**
 * ui-spec-validator.ts — Validates agent-emitted dashboard UI specs against the supported catalog.
 */
import type {
  JsonRenderElement,
  JsonRenderSpec,
  JsonRenderSpecDiagnostic
} from "./ui-types.js"

const UI_MARKER_REGEX = /<!--\s*ui:json\s+([\s\S]*?)\s*-->/g

type JsonProps = Record<string, unknown>

interface CatalogValidator {
  readonly validate: (props: JsonProps) => void
}

type ValidationResult =
  | { readonly ok: true; readonly spec: JsonRenderSpec }
  | { readonly ok: false; readonly error: string }

export interface ExtractedJsonRenderSpecReport {
  readonly spec: JsonRenderSpec | null
  readonly diagnostic: JsonRenderSpecDiagnostic
}

interface StackProps {
  readonly direction: "vertical" | "horizontal"
  readonly title?: string
}

interface CardProps {
  readonly title?: string
  readonly subtitle?: string
  readonly tone: "neutral" | "accent" | "success" | "warning" | "danger"
}

interface LegacyTextProps {
  readonly text: string
  readonly size: "sm" | "md" | "lg"
  readonly tone: "body" | "muted" | "accent"
}

interface TextProps {
  readonly content: string
  readonly variant: "h1" | "h2" | "h3" | "body" | "caption"
}

interface MetricProps {
  readonly label: string
  readonly value: string | number
}

interface MetricCardProps {
  readonly label: string
  readonly value: string
  readonly trend?: "up" | "down" | "neutral"
}

interface LegacyButtonProps {
  readonly label: string
  readonly event: string
  readonly variant: "primary" | "secondary" | "ghost"
  readonly payload?: Record<string, unknown>
}

interface ActionButtonProps {
  readonly label: string
  readonly action: string
  readonly variant: "default" | "destructive" | "outline"
  readonly payload?: Record<string, unknown>
}

interface CodeProps {
  readonly code: string
  readonly language?: string
}

interface ListProps {
  readonly items: ReadonlyArray<string>
  readonly ordered: boolean
}

interface StatusProps {
  readonly label: string
  readonly tone: "neutral" | "accent" | "success" | "warning" | "danger"
}

interface GridProps {
  readonly columns?: number
}

interface AgentCardProps {
  readonly id: string
  readonly status: "running" | "paused" | "done" | "failed" | "waiting" | "interrupted"
  readonly iteration: number
  readonly maxIterations: number
  readonly goal: string
}

interface ProgressBarProps {
  readonly value: number
  readonly max: number
  readonly label?: string
}

interface FilePreviewProps {
  readonly path: string
  readonly content: string
  readonly language?: string
}

const defineValidator = <Props extends object>(
  validator: (props: JsonProps) => Props
): CatalogValidator => ({
  validate: (props) => {
    validator(props)
  }
})

const isRecord = (value: unknown): value is JsonProps =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readString = (props: JsonProps, key: string, required = false): string | undefined => {
  const value = props[key]
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new Error(`Missing required string prop "${key}".`)
    }
    return undefined
  }
  if (typeof value !== "string") {
    throw new Error(`Prop "${key}" must be a string.`)
  }
  return value
}

const readNumber = (props: JsonProps, key: string, required = false): number | undefined => {
  const value = props[key]
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`Missing required number prop "${key}".`)
    }
    return undefined
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Prop "${key}" must be a number.`)
  }
  return value
}

const readBoolean = (props: JsonProps, key: string): boolean | undefined => {
  const value = props[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== "boolean") {
    throw new Error(`Prop "${key}" must be a boolean.`)
  }
  return value
}

const readStringArray = (props: JsonProps, key: string): ReadonlyArray<string> | undefined => {
  const value = props[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Prop "${key}" must be an array of strings.`)
  }
  return value
}

const readRecord = (props: JsonProps, key: string): Record<string, unknown> | undefined => {
  const value = props[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (!isRecord(value)) {
    throw new Error(`Prop "${key}" must be an object.`)
  }
  return value
}

const readEnum = <T extends string>(
  props: JsonProps,
  key: string,
  allowed: ReadonlyArray<T>,
  fallback: T
): T => {
  const value = props[key]
  if (value === undefined || value === null || value === "") {
    return fallback
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Prop "${key}" must be one of: ${allowed.join(", ")}.`)
  }
  return value as T
}

const catalogValidators = {
  AgentCard: defineValidator<AgentCardProps>((props) => ({
    id: readString(props, "id", true) ?? "",
    status: readEnum(
      props,
      "status",
      ["running", "paused", "done", "failed", "waiting", "interrupted"] as const,
      "waiting"
    ),
    iteration: readNumber(props, "iteration", true) ?? 0,
    maxIterations: readNumber(props, "maxIterations", true) ?? 0,
    goal: readString(props, "goal", true) ?? ""
  })),
  ProgressBar: defineValidator<ProgressBarProps>((props) => ({
    value: readNumber(props, "value", true) ?? 0,
    max: readNumber(props, "max", true) ?? 0,
    label: readString(props, "label")
  })),
  FilePreview: defineValidator<FilePreviewProps>((props) => ({
    path: readString(props, "path", true) ?? "",
    content: readString(props, "content", true) ?? "",
    language: readString(props, "language")
  })),
  MetricCard: defineValidator<MetricCardProps>((props) => ({
    label: readString(props, "label", true) ?? "",
    value: readString(props, "value", true) ?? "",
    trend: readEnum(props, "trend", ["up", "down", "neutral"] as const, "neutral")
  })),
  CodeBlock: defineValidator<CodeProps>((props) => ({
    code: readString(props, "code", true) ?? "",
    language: readString(props, "language")
  })),
  Text: defineValidator<TextProps>((props) => ({
    content: readString(props, "content", true) ?? "",
    variant: readEnum(props, "variant", ["h1", "h2", "h3", "body", "caption"] as const, "body")
  })),
  ActionButton: defineValidator<ActionButtonProps>((props) => ({
    label: readString(props, "label", true) ?? "",
    action: readString(props, "action", true) ?? "",
    variant: readEnum(
      props,
      "variant",
      ["default", "destructive", "outline"] as const,
      "default"
    ),
    payload: readRecord(props, "payload")
  })),
  Card: defineValidator<CardProps>((props) => ({
    title: readString(props, "title"),
    subtitle: readString(props, "subtitle"),
    tone: readEnum(props, "tone", ["neutral", "accent", "success", "warning", "danger"] as const, "neutral")
  })),
  Grid: defineValidator<GridProps>((props) => ({
    columns: readNumber(props, "columns")
  })),
  Stack: defineValidator<StackProps>((props) => ({
    direction: readEnum(props, "direction", ["vertical", "horizontal"] as const, "vertical"),
    title: readString(props, "title")
  })),
  stack: defineValidator<StackProps>((props) => ({
    direction: readEnum(props, "direction", ["vertical", "horizontal"] as const, "vertical"),
    title: readString(props, "title")
  })),
  panel: defineValidator<CardProps>((props) => ({
    title: readString(props, "title"),
    subtitle: readString(props, "subtitle"),
    tone: readEnum(props, "tone", ["neutral", "accent", "success", "warning", "danger"] as const, "neutral")
  })),
  text: defineValidator<LegacyTextProps>((props) => ({
    text: readString(props, "text", true) ?? "",
    size: readEnum(props, "size", ["sm", "md", "lg"] as const, "md"),
    tone: readEnum(props, "tone", ["body", "muted", "accent"] as const, "body")
  })),
  metric: defineValidator<MetricProps>((props) => {
    const label = readString(props, "label", true) ?? ""
    const value = props.value
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error('Prop "value" must be a string or number.')
    }
    return {
      label,
      value,
    }
  }),
  button: defineValidator<LegacyButtonProps>((props) => ({
    label: readString(props, "label", true) ?? "",
    event: readString(props, "event", true) ?? "",
    variant: readEnum(props, "variant", ["primary", "secondary", "ghost"] as const, "primary"),
    payload: readRecord(props, "payload")
  })),
  code: defineValidator<CodeProps>((props) => ({
    code: readString(props, "code", true) ?? "",
    language: readString(props, "language")
  })),
  list: defineValidator<ListProps>((props) => ({
    items: readStringArray(props, "items") ?? [],
    ordered: readBoolean(props, "ordered") ?? false
  })),
  status: defineValidator<StatusProps>((props) => ({
    label: readString(props, "label", true) ?? "",
    tone: readEnum(props, "tone", ["neutral", "accent", "success", "warning", "danger"] as const, "neutral")
  })),
  grid: defineValidator<GridProps>((props) => ({
    columns: readNumber(props, "columns")
  }))
} as const

const validateElementShape = (
  nodeId: string,
  value: unknown
): JsonRenderElement => {
  if (!isRecord(value)) {
    throw new Error(`Node "${nodeId}" was not found.`)
  }

  if (typeof value.component !== "string") {
    throw new Error(`Node "${nodeId}" is missing a component name.`)
  }

  const validator = catalogValidators[value.component as keyof typeof catalogValidators]
  if (!validator) {
    throw new Error(`Unknown component "${value.component}" in node "${nodeId}".`)
  }

  if (!isRecord(value.props)) {
    throw new Error(`Node "${nodeId}" has invalid props.`)
  }

  if (
    value.children !== undefined &&
    (!Array.isArray(value.children) || value.children.some((child) => typeof child !== "string"))
  ) {
    throw new Error(`Node "${nodeId}" has invalid children.`)
  }

  validator.validate(value.props)
  return {
    component: value.component,
    props: value.props,
    children: value.children
  }
}

const assertAcyclicTree = (
  nodeId: string,
  elements: Record<string, unknown>,
  trail: ReadonlyArray<string>
): void => {
  if (trail.includes(nodeId)) {
    throw new Error(`Cycle detected while validating node "${nodeId}".`)
  }

  const node = validateElementShape(nodeId, elements[nodeId])
  for (const childId of node.children ?? []) {
    if (!(childId in elements)) {
      throw new Error(`Node "${nodeId}" references missing child "${childId}".`)
    }
    assertAcyclicTree(childId, elements, [...trail, nodeId])
  }
}

export const validateJsonRenderSpec = (value: unknown): ValidationResult => {
  try {
    if (!isRecord(value) || typeof value.root !== "string" || !isRecord(value.elements)) {
      throw new Error("Invalid JsonRenderSpec shape.")
    }

    if (!(value.root in value.elements)) {
      throw new Error(`Root node "${value.root}" was not found.`)
    }

    const elements: Record<string, JsonRenderElement> = {}
    for (const [nodeId, nodeValue] of Object.entries(value.elements)) {
      elements[nodeId] = validateElementShape(nodeId, nodeValue)
    }

    assertAcyclicTree(value.root, elements, [])
    return {
      ok: true,
      spec: {
        root: value.root,
        elements
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid JsonRenderSpec."
    }
  }
}

export const extractValidatedJsonRenderSpec = (text: string): JsonRenderSpec | null =>
  extractJsonRenderSpecReport(text).spec

export const extractJsonRenderSpecReport = (text: string): ExtractedJsonRenderSpecReport => {
  let latest: JsonRenderSpec | null = null
  let latestError: string | undefined
  let markerCount = 0

  for (const match of text.matchAll(UI_MARKER_REGEX)) {
    markerCount += 1
    const raw = match[1]?.trim()
    if (!raw) {
      latestError = "Encountered an empty ui:json marker."
      continue
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      const validation = validateJsonRenderSpec(parsed)
      if (validation.ok) {
        latest = validation.spec
        latestError = undefined
      } else {
        latestError = validation.error
      }
    } catch {
      latestError = "ui:json marker payload was not valid JSON."
    }
  }

  return {
    spec: latest,
    diagnostic: {
      ok: latest !== null,
      error: latest === null ? latestError : undefined,
      markerCount,
      updatedAt: Date.now()
    }
  }
}
