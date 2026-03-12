/**
 * checks.ts — Built-in evaluator checks that inspect local workspace state.
 */
import { Effect } from "effect"
import * as childProcess from "node:child_process"
import * as fs from "node:fs"
import type { EvalResult } from "../loop-types.js"

export type CheckFn = (
  args: Record<string, string>
) => (goal: string, output: string) => Effect.Effect<EvalResult, Error>

export interface CheckSpec {
  readonly requiredArgs?: ReadonlyArray<string>
}

export const builtinCheckSpecs: Record<string, CheckSpec> = {
  "file-exists": { requiredArgs: ["path"] },
  "file-not-empty": { requiredArgs: ["path"] },
  "file-contains": { requiredArgs: ["path", "pattern"] },
  "json-valid": { requiredArgs: ["path"] },
  "tests-pass": {}
}

export const builtinChecks: Record<string, CheckFn> = {
  "file-exists": (args) => (_goal, _output) =>
    Effect.try({
      try: () =>
        fs.existsSync(args.path)
          ? { done: true, reason: "File exists" }
          : { done: false, reason: `File not found: ${args.path}` },
      catch: (error) => new Error(`Check failed: ${error}`)
    }),

  "file-not-empty": (args) => (_goal, _output) =>
    Effect.try({
      try: () => {
        const stat = fs.statSync(args.path)
        return stat.size > 0
          ? { done: true, reason: "File is not empty" }
          : { done: false, reason: `File is empty: ${args.path}` }
      },
      catch: (error) => new Error(`Check failed: ${error}`)
    }),

  "file-contains": (args) => (_goal, _output) =>
    Effect.try({
      try: () => {
        const content = fs.readFileSync(args.path, "utf-8")
        return content.includes(args.pattern)
          ? { done: true, reason: `File contains "${args.pattern}"` }
          : { done: false, reason: `File does not contain "${args.pattern}": ${args.path}` }
      },
      catch: (error) => new Error(`Check failed: ${error}`)
    }),

  "json-valid": (args) => (_goal, _output) =>
    Effect.try({
      try: () => {
        const content = fs.readFileSync(args.path, "utf-8")
        JSON.parse(content)
        return { done: true, reason: "Valid JSON" }
      },
      catch: () => new Error("Invalid JSON")
    }).pipe(
      Effect.catchAll((error) =>
        Effect.succeed({ done: false, reason: `Invalid JSON: ${error.message}` })
      )
    ),

  "tests-pass": (args) => (_goal, _output) =>
    Effect.try({
      try: () => {
        childProcess.execSync(args.command ?? "npm test", { stdio: "pipe" })
        return { done: true, reason: "Tests pass" }
      },
      catch: (error) => {
        const stderr =
          typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: Buffer | string }).stderr ?? "")
            : ""
        return new Error(stderr || "Tests failed")
      }
    }).pipe(
      Effect.catchAll((error) =>
        Effect.succeed({
          done: false,
          reason: `Tests failed: ${error.message.slice(0, 200)}`
        })
      )
    )
}
