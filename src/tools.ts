/**
 * tools.ts — The 5 tools from Geoff's coding agent, ported to Effect Schema.
 *
 * In @effect/ai, tools are DEFINED as schemas, handlers provided via toLayer().
 * This matches the separation of concerns: schema = what, handler = how.
 */
import { Tool, Toolkit } from "@effect/ai"
import { Effect, Schema } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import * as childProcess from "node:child_process"

// ---------------------------------------------------------------------------
// Tool definitions (schemas only — no handlers inline)
// ---------------------------------------------------------------------------

export const ReadFile = Tool.make("ReadFile", {
  description:
    "Read the contents of a given relative file path. Use this when you want to see what's inside a file. Do not use this with directory names.",
  parameters: { path: Schema.String },
  success: Schema.String
})

export const ListFiles = Tool.make("ListFiles", {
  description:
    "List files and directories at a given path. If no path is provided, lists files in the current directory.",
  parameters: {
    path: Schema.optionalWith(Schema.String, { default: () => "." })
  },
  success: Schema.String
})

export const Bash = Tool.make("Bash", {
  description: "Execute a bash command and return its output. Use this to run shell commands.",
  parameters: { command: Schema.String },
  success: Schema.String
})

export const EditFile = Tool.make("EditFile", {
  description:
    "Make edits to a text file. Replaces 'old_str' with 'new_str' in the given file. 'old_str' and 'new_str' MUST be different. If the file doesn't exist and old_str is empty, it will be created.",
  parameters: {
    path: Schema.String,
    old_str: Schema.String,
    new_str: Schema.String
  },
  success: Schema.String
})

export const CodeSearch = Tool.make("CodeSearch", {
  description:
    "Search for code patterns using ripgrep. Use this to find code patterns, function definitions, variable usage, or any text in the codebase.",
  parameters: {
    pattern: Schema.String,
    path: Schema.optionalWith(Schema.String, { default: () => "." }),
    file_type: Schema.optionalWith(Schema.String, { default: () => "" })
  },
  success: Schema.String
})

// ---------------------------------------------------------------------------
// Toolkit composition — flat list, just like Geoff's Go version
// ---------------------------------------------------------------------------

export const AgentToolkit = Toolkit.make(ReadFile, ListFiles, Bash, EditFile, CodeSearch)

// ---------------------------------------------------------------------------
// Handler implementations — pure functions separated from definitions
// ---------------------------------------------------------------------------

export const readFileImpl = ({ path: filePath }: { readonly path: string }) =>
  Effect.try({
    try: () => fs.readFileSync(filePath, "utf-8"),
    catch: (e) => new Error(`Failed to read file ${filePath}: ${e}`)
  })

export const listFilesImpl = ({ path: dirPath }: { readonly path: string }) =>
  Effect.try({
    try: () => {
      const dir = dirPath || "."
      const results: string[] = []
      const walk = (d: string): void => {
        const entries = fs.readdirSync(d, { withFileTypes: true })
        for (const entry of entries) {
          const rel = path.relative(dir, path.join(d, entry.name))
          if (entry.name === ".git" || entry.name === ".devenv" || entry.name === "node_modules")
            continue
          if (entry.isDirectory()) {
            results.push(rel + "/")
            walk(path.join(d, entry.name))
          } else {
            results.push(rel)
          }
        }
      }
      walk(dir)
      return JSON.stringify(results)
    },
    catch: (e) => new Error(`Failed to list files: ${e}`)
  })

export const bashImpl = ({ command }: { readonly command: string }) =>
  Effect.try({
    try: () => {
      const result = childProcess.execSync(command, {
        encoding: "utf-8",
        timeout: 30000,
        maxBuffer: 1024 * 1024
      })
      return result.trim()
    },
    catch: (e: any) => {
      const output = e.stdout || e.stderr || ""
      return new Error(`Command failed: ${e.message}\nOutput: ${output}`)
    }
  })

export const editFileImpl = ({
  path: filePath,
  old_str,
  new_str
}: {
  readonly path: string
  readonly old_str: string
  readonly new_str: string
}) =>
  Effect.try({
    try: () => {
      if (!filePath || old_str === new_str) throw new Error("invalid input parameters")

      let content: string
      try {
        content = fs.readFileSync(filePath, "utf-8")
      } catch {
        if (old_str === "") {
          const dir = path.dirname(filePath)
          if (dir !== ".") fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(filePath, new_str, "utf-8")
          return `Successfully created file ${filePath}`
        }
        throw new Error(`File not found: ${filePath}`)
      }

      if (old_str === "") {
        fs.writeFileSync(filePath, content + new_str, "utf-8")
        return "OK"
      }

      // Unique match invariant — exactly one occurrence
      const count = content.split(old_str).length - 1
      if (count === 0) throw new Error("old_str not found in file")
      if (count > 1) throw new Error(`old_str found ${count} times in file, must be unique`)

      const newContent = content.replace(old_str, new_str)
      fs.writeFileSync(filePath, newContent, "utf-8")
      return "OK"
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e)))
  })

export const codeSearchImpl = ({
  pattern,
  path: searchPath,
  file_type
}: {
  readonly pattern: string
  readonly path: string
  readonly file_type: string
}) =>
  Effect.try({
    try: () => {
      const args = ["rg", "--line-number", "--with-filename", "--color=never", "--ignore-case"]
      if (file_type) args.push("--type", file_type)
      args.push(pattern)
      args.push(searchPath || ".")

      const result = childProcess.execSync(args.join(" "), {
        encoding: "utf-8",
        maxBuffer: 1024 * 1024
      })

      const lines = result.trim().split("\n")
      if (lines.length > 50) {
        return (
          lines.slice(0, 50).join("\n") + `\n... (showing first 50 of ${lines.length} matches)`
        )
      }
      return result.trim()
    },
    catch: (e: any) => {
      if (e.status === 1) return new Error("No matches found")
      return new Error(`Search failed: ${e.message}`)
    }
  })

// ---------------------------------------------------------------------------
// The Layer — wires handlers to tool definitions
// ---------------------------------------------------------------------------

// Wrap handlers to catch errors → return error string (matches Go pattern)
const infallible = <A extends Record<string, unknown>>(
  fn: (params: A) => Effect.Effect<string, Error>
) =>
  (params: A) =>
    fn(params).pipe(
      Effect.catchAll((e) => Effect.succeed(`ERROR: ${e.message}`))
    )

export const AgentToolkitLive = AgentToolkit.toLayer({
  ReadFile: infallible(readFileImpl),
  ListFiles: infallible(listFilesImpl),
  Bash: infallible(bashImpl),
  EditFile: infallible(editFileImpl),
  CodeSearch: infallible(codeSearchImpl)
})
