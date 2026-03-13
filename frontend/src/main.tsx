/**
 * main.tsx — Browser entry point for the dashboard.
 */
import { App } from "./App.js"
import { createRoot, h } from "./lib/mini-react.js"

const mount = document.querySelector<HTMLElement>("#app")

if (!mount) {
  throw new Error("Dashboard mount node #app was not found.")
}

createRoot(mount).render(<App />)
