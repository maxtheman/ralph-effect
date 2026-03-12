/**
 * cli.ts — Command-line entry point for executing `.prose` workflows.
 */
import { Console, Effect } from "effect"
import { CodexLLMLive } from "../codex-client.js"
import { OrchestratorLive } from "../orchestrator.js"
import { runWorkflow } from "./index.js"

const filePath = process.argv[2]

if (!filePath) {
  console.log("Usage: npx tsx src/dsl/cli.ts <workflow.prose>")
  process.exit(1)
}

const main = runWorkflow(filePath).pipe(
  Effect.provide(OrchestratorLive),
  Effect.provide(CodexLLMLive),
  Effect.scoped,
  Effect.catchAll((error) => Console.log(`Workflow failed: ${error}`))
)

Effect.runPromise(main)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
