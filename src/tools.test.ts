/**
 * tools.test.ts — Unit tests for tool handlers.
 *
 * Tests the pure functions directly (no LLM needed).
 * Verifies Geoff's invariants are preserved in the port.
 */
import { Effect } from "effect"
import {
  readFileImpl,
  listFilesImpl,
  bashImpl,
  editFileImpl
} from "./tools.js"
import * as fs from "node:fs"
import * as path from "node:path"

const TMP_DIR = "/tmp/ralph-effect-test-" + Date.now()

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
let passed = 0
let failed = 0

const test = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn()
    console.log(`  \x1b[92m✓\x1b[0m ${name}`)
    passed++
  } catch (e: any) {
    console.log(`  \x1b[91m✗\x1b[0m ${name}`)
    console.log(`    ${e.message || e}`)
    failed++
  }
}

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

const assertContains = (haystack: string, needle: string, label: string): void => {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: expected to contain "${needle}", got "${haystack}"`)
  }
}

const run = <A>(effect: Effect.Effect<A, Error>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
const setup = () => {
  fs.mkdirSync(TMP_DIR, { recursive: true })
  fs.writeFileSync(path.join(TMP_DIR, "hello.txt"), "Hello, World!\n", "utf-8")
  fs.writeFileSync(
    path.join(TMP_DIR, "unique.txt"),
    "line one\nline two\nline three\n",
    "utf-8"
  )
  fs.writeFileSync(
    path.join(TMP_DIR, "duplicate.txt"),
    "foo bar foo baz\n",
    "utf-8"
  )
}

const teardown = () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
const main = async () => {
  setup()

  console.log("\n\x1b[1mTool Handler Tests\x1b[0m\n")

  // --- ReadFile ---
  console.log("\x1b[94mReadFile\x1b[0m")

  await test("reads existing file", async () => {
    const result = await run(readFileImpl({ path: path.join(TMP_DIR, "hello.txt") }))
    assertEq(result, "Hello, World!\n", "file content")
  })

  await test("fails on missing file", async () => {
    try {
      await run(readFileImpl({ path: path.join(TMP_DIR, "nope.txt") }))
      throw new Error("should have thrown")
    } catch (e: any) {
      assertContains(e.message, "Failed to read file", "error message")
    }
  })

  // --- ListFiles ---
  console.log("\n\x1b[94mListFiles\x1b[0m")

  await test("lists files in directory", async () => {
    const result = await run(listFilesImpl({ path: TMP_DIR }))
    const files: string[] = JSON.parse(result)
    assert(files.includes("hello.txt"), "should contain hello.txt")
    assert(files.includes("unique.txt"), "should contain unique.txt")
  })

  // --- Bash ---
  console.log("\n\x1b[94mBash\x1b[0m")

  await test("executes command and returns output", async () => {
    const result = await run(bashImpl({ command: "echo hello" }))
    assertEq(result, "hello", "echo output")
  })

  await test("handles command failure gracefully", async () => {
    try {
      await run(bashImpl({ command: "exit 1" }))
      throw new Error("should have thrown")
    } catch (e: any) {
      assertContains(e.message, "Command failed", "error message")
    }
  })

  // --- EditFile ---
  console.log("\n\x1b[94mEditFile (Geoff's invariants)\x1b[0m")

  await test("replaces unique match", async () => {
    const filePath = path.join(TMP_DIR, "unique.txt")
    const result = await run(
      editFileImpl({ path: filePath, old_str: "line two", new_str: "LINE TWO" })
    )
    assertEq(result, "OK", "should return OK")
    const content = fs.readFileSync(filePath, "utf-8")
    assertContains(content, "LINE TWO", "replacement applied")
    assert(!content.includes("line two"), "old string removed")
  })

  await test("fails on non-unique match (>1 occurrences)", async () => {
    const filePath = path.join(TMP_DIR, "duplicate.txt")
    try {
      await run(editFileImpl({ path: filePath, old_str: "foo", new_str: "FOO" }))
      throw new Error("should have thrown")
    } catch (e: any) {
      assertContains(e.message, "found 2 times", "error message")
    }
  })

  await test("fails on zero matches", async () => {
    const filePath = path.join(TMP_DIR, "hello.txt")
    try {
      await run(editFileImpl({ path: filePath, old_str: "NOPE", new_str: "YES" }))
      throw new Error("should have thrown")
    } catch (e: any) {
      assertContains(e.message, "not found", "error message")
    }
  })

  await test("creates new file when old_str is empty and file missing", async () => {
    const filePath = path.join(TMP_DIR, "subdir", "new.txt")
    const result = await run(editFileImpl({ path: filePath, old_str: "", new_str: "brand new" }))
    assertContains(result, "Successfully created", "creation message")
    const content = fs.readFileSync(filePath, "utf-8")
    assertEq(content, "brand new", "file content")
  })

  await test("appends when old_str is empty and file exists", async () => {
    const filePath = path.join(TMP_DIR, "hello.txt")
    const result = await run(editFileImpl({ path: filePath, old_str: "", new_str: "appended!" }))
    assertEq(result, "OK", "should return OK")
    const content = fs.readFileSync(filePath, "utf-8")
    assertContains(content, "appended!", "appended content")
  })

  await test("rejects when old_str === new_str", async () => {
    try {
      await run(editFileImpl({ path: path.join(TMP_DIR, "hello.txt"), old_str: "x", new_str: "x" }))
      throw new Error("should have thrown")
    } catch (e: any) {
      assertContains(e.message, "invalid input", "error message")
    }
  })

  // --- Summary ---
  teardown()
  console.log(`\n\x1b[1mResults: ${passed} passed, ${failed} failed\x1b[0m\n`)
  if (failed > 0) process.exit(1)
}

main()
