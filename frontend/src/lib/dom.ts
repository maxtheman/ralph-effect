/**
 * dom.ts — Small DOM helpers for the frontend fallback UI.
 */
export type Child = Node | string | number | false | null | undefined

export interface ElementOptions {
  readonly className?: string
  readonly text?: string
  readonly html?: string
  readonly attrs?: Record<string, string | number | boolean | undefined>
  readonly dataset?: Record<string, string | undefined>
}

export const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  ...children: ReadonlyArray<Child>
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)

  if (options.className) node.className = options.className
  if (options.text !== undefined) node.textContent = options.text
  if (options.html !== undefined) node.innerHTML = options.html

  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value === undefined || value === false) continue
      if (value === true) {
        node.setAttribute(key, "")
        continue
      }
      node.setAttribute(key, String(value))
    }
  }

  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) {
      if (value !== undefined) {
        node.dataset[key] = value
      }
    }
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }

  return node
}

export const clearElement = (node: Element): void => {
  while (node.firstChild) {
    node.removeChild(node.firstChild)
  }
}

export const formatTimestamp = (value?: number): string => {
  if (!value) return "now"
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(value)
}

export const formatRelativeTime = (value?: number): string => {
  if (!value) return "pending"
  const deltaMs = Date.now() - value
  const deltaSec = Math.round(deltaMs / 1000)
  if (deltaSec < 10) return "just now"
  if (deltaSec < 60) return `${deltaSec}s ago`
  const deltaMin = Math.round(deltaSec / 60)
  if (deltaMin < 60) return `${deltaMin}m ago`
  const deltaHr = Math.round(deltaMin / 60)
  return `${deltaHr}h ago`
}
