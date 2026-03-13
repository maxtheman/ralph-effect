/**
 * mini-react.ts — Thin compatibility bridge over real React/React DOM.
 */
import * as React from "react"
import { createRoot as createReactRoot } from "react-dom/client"

export const Fragment = React.Fragment
export const h = React.createElement
export const useState = React.useState
export const useEffect = React.useEffect
export const useMemo = React.useMemo
export const useRef = React.useRef
export const useCallback = React.useCallback
export const useDeferredValue = React.useDeferredValue
export const startTransition = React.startTransition

export const useEffectEvent = <T extends (...args: never[]) => unknown>(callback: T): T => callback

export const createRoot = (container: Element | DocumentFragment) =>
  createReactRoot(container)
