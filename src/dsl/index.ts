/**
 * index.ts — Public API for loading, compiling, and running OpenProse workflows.
 */
import { Effect } from "effect"
import * as fs from "node:fs"
import type { Orchestrator } from "../orchestrator.js"
import { compile } from "./compiler.js"
import { parse } from "./parser.js"

/** Load and compile a `.prose` workflow file. */
export const loadWorkflow = (
  filePath: string
): Effect.Effect<Effect.Effect<void, Error, Orchestrator>, Error> =>
  Effect.gen(function* () {
    const source = yield* Effect.try({
      try: () => fs.readFileSync(filePath, "utf-8"),
      catch: (error) => new Error(`Failed to read ${filePath}: ${error}`)
    })

    const parseResult = parse(source)
    if (!parseResult.ok) {
      const message = parseResult.errors
        .map((error) => `  Line ${error.line}: ${error.message}`)
        .join("\n")
      return yield* Effect.fail(new Error(`Parse errors:\n${message}`))
    }

    const compileResult = compile(parseResult.program)
    if (!compileResult.ok) {
      const message = compileResult.errors
        .map((error) => `  Line ${error.line}: ${error.message}`)
        .join("\n")
      return yield* Effect.fail(new Error(`Compile errors:\n${message}`))
    }

    return compileResult.effect
  })

/** Parse, compile, and run a `.prose` workflow. */
export const runWorkflow = (filePath: string): Effect.Effect<void, Error, Orchestrator> =>
  Effect.gen(function* () {
    const workflow = yield* loadWorkflow(filePath)
    yield* workflow
  })

export type { Program, Declaration } from "./ast.js"
export { compile } from "./compiler.js"
export { parse } from "./parser.js"
