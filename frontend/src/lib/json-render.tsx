import * as React from "react"

export interface JsonRenderNode {
  readonly key: string
  readonly type: string
  readonly props?: Record<string, unknown>
  readonly children?: ReadonlyArray<JsonRenderNode>
}

export interface JsonRenderComponentDefinition {
  readonly props?: { parse: (value: unknown) => Record<string, unknown> }
  readonly hasChildren?: boolean
}

export interface JsonRenderActionDefinition {
  readonly props?: { parse: (value: unknown) => Record<string, unknown> }
}

export interface JsonRenderCatalog {
  readonly components: Record<string, JsonRenderComponentDefinition>
  readonly actions?: Record<string, JsonRenderActionDefinition>
}

export interface RendererComponentProps {
  readonly children?: ReadonlyArray<JSX.Element>
  readonly emit?: (event: string, payload?: Record<string, unknown>) => void
}

export type RendererRegistry = Record<string, (props: any) => JSX.Element>

export interface RendererProps {
  readonly tree: JsonRenderNode
  readonly registry: RendererRegistry
  readonly onAction?: (event: string, payload?: Record<string, unknown>) => void
  readonly fallback?: (error: unknown) => JSX.Element
}

export const createCatalog = <TCatalog extends JsonRenderCatalog>(catalog: TCatalog): TCatalog =>
  catalog

const renderNode = (
  node: JsonRenderNode,
  registry: RendererRegistry,
  onAction?: (event: string, payload?: Record<string, unknown>) => void
): JSX.Element => {
  const component = registry[node.type]
  if (!component) {
    throw new Error(`Unsupported component "${node.type}".`)
  }

  return component({
    ...(node.props ?? {}),
    children: (node.children ?? []).map((child) => renderNode(child, registry, onAction)),
    emit: onAction
  })
}

export const Renderer = ({
  tree,
  registry,
  onAction,
  fallback
}: RendererProps): JSX.Element => {
  try {
    return renderNode(tree, registry, onAction)
  } catch (error) {
    if (fallback) {
      return fallback(error)
    }

    return React.createElement(
      "div",
      { className: "agent-surface__error" },
      error instanceof Error ? error.message : "Invalid json-render tree."
    )
  }
}
