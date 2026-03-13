/**
 * cli-server.ts — Starts the dashboard backend and optionally runs a workflow.
 *
 * Usage:
 *   npx tsx src/cli-server.ts
 *   npx tsx src/cli-server.ts examples/hello-world.prose
 */
import * as path from "node:path"
import { createDashboardServer } from "./server.js"

const main = async (): Promise<void> => {
  const workflowArg = process.argv[2]
  const server = await createDashboardServer()

  let shuttingDown = false
  const shutdown = async (exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    try {
      await server.close()
    } finally {
      process.exit(exitCode)
    }
  }

  process.once("SIGINT", () => {
    void shutdown(0)
  })
  process.once("SIGTERM", () => {
    void shutdown(0)
  })

  try {
    await server.listen()
    console.log(`Ralph dashboard backend listening at http://${server.host}:${server.port}`)

    if (workflowArg) {
      const workflowPath = path.resolve(process.cwd(), workflowArg)
      console.log(`Loading workflow ${workflowPath}`)
      await server.runWorkflow(workflowPath)
      console.log(`Workflow started: ${workflowPath}`)
    }
  } catch (error) {
    console.error(error)
    await shutdown(1)
  }
}

void main()
