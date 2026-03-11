/**
 * tools.ts — The 5 tools from Geoff's coding agent, ported to Effect Schema tools.
 *
 * Invariant preserved: Tool = (name, schema, function)
 * Invariant gained: Each tool is now an Effect with typed errors, composable, testable.
 */
import { Schema } from "effect"
import { Tool, Toolkit } from "@effect/ai"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"
import * as childProcess from "node:child_process"

// ---------------------------------------------------------------------------
// 1. read_file
// ---------------------------------------------------------------------------
const ReadFileTool = Tool.make("read_file", {
  description:
    "Read the contents of a given relative file path. Use this when you want to see what's inside a file. Do not use this with directory names.",
  parameters: { path: Schema.String },
  success: Schema.String,
  execute: ({ path: filePath }) =>
    Effect.try({
      try: () => fs.readFileSync(filePath, "utf-8"),
      catch: (e) => new Error(`Failed to read file ${filePath}: ${e}`)
    })
})

// ---------------------------------------------------------------------------
// 2. list_files
// ---------------------------------------------------------------------------
const ListFilesTool = Tool.make("list_files", {
  description:
    "List files and directories at a given path. If no path is provided, lists files in the current directory.",
  parameters: { path: Schema.optional(Schema.String) },
  success: Schema.String,
  execute: ({ path: dirPath }) =>
    Effect.try({
      try: () => {
        const dir = dirPath || "."
        const results: string[] = []
        const walk = (d: string) => {
          const entries = fs.readdirSync(d, { withFileTypes: true })
          for (const entry of entries) {
            const rel = path.relative(dir, path.join(d, entry.name))
            if (
              entry.name === ".git" ||
              entry.name === ".devenv" ||
              entry.name === "node_modules"
            )
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
})

// ---------------------------------------------------------------------------
// 3. bash
// ---------------------------------------------------------------------------
const BashTool = Tool.make("bash", {
  description: "Execute a bash command and return its output. Use this to run shell commands.",
  parameters: { command: Schema.String },
  success: Schema.String,
  execute: ({ command }) =>
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
})

// ---------------------------------------------------------------------------
// 4. edit_file — preserves Geoff's unique-match invariant
// ---------------------------------------------------------------------------
const EditFileTool = Tool.make("edit_file", {
  description: `Make edits to a text file. Replaces 'old_str' with 'new_str' in the given file. 'old_str' and 'new_str' MUST be different from each other. If the file doesn't exist and old_str is empty, it will be created.`,
  parameters: {
    path: Schema.String,
    old_str: Schema.String,
    new_str: Schema.String
  },
  success: Schema.String,
  execute: ({ path: filePath, old_str, new_str }) =>
    Effect.try({
      try: () => {
        if (!filePath || old_str === new_str) {
          throw new Error("invalid input parameters")
        }

        let content: string
        try {
          content = fs.readFileSync(filePath, "utf-8")
        } catch {
          // File doesn't exist — create if old_str is empty
          if (old_str === "") {
            const dir = path.dirname(filePath)
            if (dir !== ".") fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(filePath, new_str, "utf-8")
            return `Successfully created file ${filePath}`
          }
          throw new Error(`File not found: ${filePath}`)
        }

        if (old_str === "") {
          // Append mode
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
})

// ---------------------------------------------------------------------------
// 5. code_search — ripgrep wrapper
// ---------------------------------------------------------------------------
const CodeSearchTool = Tool.make("code_search", {
  description:
    "Search for code patterns using ripgrep. Use this to find code patterns, function definitions, variable usage, or any text in the codebase.",
  parameters: {
    pattern: Schema.String,
    path: Schema.optional(Schema.String),
    file_type: Schema.optional(Schema.String)
  },
  success: Schema.String,
  execute: ({ pattern, path: searchPath, file_type }) =>
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
          return lines.slice(0, 50).join("\n") + `\n... (showing first 50 of ${lines.length} matches)`
        }
        return result.trim()
      },
      catch: (e: any) => {
        if (e.status === 1) return new Error("No matches found")
        return new Error(`Search failed: ${e.message}`)
      }
    })
})

// ---------------------------------------------------------------------------
// Compose into a Toolkit — the flat list, just like Geoff's Go version
// ---------------------------------------------------------------------------
export const AgentToolkit = Toolkit.make(
  ReadFileTool,
  ListFilesTool,
  BashTool,
  EditFileTool,
  CodeSearchTool
)

export {
  ReadFileTool,
  ListFilesTool,
  BashTool,
  EditFileTool,
  CodeSearchTool
}
