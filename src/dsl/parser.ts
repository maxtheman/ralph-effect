/**
 * parser.ts — Recursive descent parser for indentation-sensitive `.prose` files.
 */
import type {
  AgentDecl,
  Declaration,
  EvaluateAnnotation,
  IfBlock,
  IfBranch,
  LetDecl,
  LoopUntilBlock,
  MapExpr,
  ParallelBlock,
  PipeDecl,
  Program,
  ReduceExpr,
  SessionBlock,
  TryBlock
} from "./ast.js"

interface SourceLine {
  readonly line: number
  readonly indent: number
  readonly text: string
}

export interface ParseError {
  readonly line: number
  readonly message: string
}

export type ParseResult =
  | { readonly ok: true; readonly program: Program }
  | { readonly ok: false; readonly errors: ReadonlyArray<ParseError> }

const IDENT = "[A-Za-z_][A-Za-z0-9_-]*"
const identifierRegex = new RegExp(`^${IDENT}$`)

const splitCommaSeparated = (text: string): string[] => {
  const parts: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null

  for (const char of text) {
    if ((char === '"' || char === "'") && quote === null) {
      quote = char
      current += char
      continue
    }
    if (quote !== null && char === quote) {
      quote = null
      current += char
      continue
    }
    if (char === "," && quote === null) {
      parts.push(current.trim())
      current = ""
      continue
    }
    current += char
  }

  if (current.trim() !== "") {
    parts.push(current.trim())
  }

  return parts
}

const stripQuotes = (value: string): string => {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

const parseBracketList = (value: string): ReadonlyArray<string> => {
  const trimmed = value.trim()
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`Expected bracket list, got: ${value}`)
  }
  const inner = trimmed.slice(1, -1).trim()
  if (inner === "") {
    return []
  }
  return splitCommaSeparated(inner).map((item) => stripQuotes(item.trim()))
}

const parseArgsObject = (value: string): Record<string, string> => {
  const trimmed = value.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error(`Expected object literal, got: ${value}`)
  }
  const inner = trimmed.slice(1, -1).trim()
  if (inner === "") {
    return {}
  }

  const entries = splitCommaSeparated(inner)
  const result: Record<string, string> = {}

  for (const entry of entries) {
    const colon = entry.indexOf(":")
    if (colon < 0) {
      throw new Error(`Invalid object entry: ${entry}`)
    }
    const key = entry.slice(0, colon).trim()
    const rawValue = entry.slice(colon + 1).trim()
    if (!identifierRegex.test(key)) {
      throw new Error(`Invalid object key: ${key}`)
    }
    result[key] = stripQuotes(rawValue)
  }

  return result
}

const preprocess = (source: string): {
  readonly lines: ReadonlyArray<SourceLine>
  readonly errors: ReadonlyArray<ParseError>
} => {
  const lines: SourceLine[] = []
  const errors: ParseError[] = []
  const rawLines = source.split(/\r?\n/)

  rawLines.forEach((rawLine, index) => {
    const lineNumber = index + 1
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) {
      return
    }
    if (rawLine.includes("\t")) {
      errors.push({
        line: lineNumber,
        message: "Tabs are not allowed; use 2-space indentation"
      })
      return
    }
    const leadingSpaces = rawLine.match(/^ */)?.[0].length ?? 0
    if (leadingSpaces % 2 !== 0) {
      errors.push({
        line: lineNumber,
        message: "Indentation must be in multiples of 2 spaces"
      })
      return
    }

    lines.push({
      line: lineNumber,
      indent: leadingSpaces / 2,
      text: rawLine.slice(leadingSpaces).trimEnd()
    })
  })

  return { lines, errors }
}

class Parser {
  private readonly errors: ParseError[]
  private index = 0

  constructor(
    private readonly lines: ReadonlyArray<SourceLine>,
    initialErrors: ReadonlyArray<ParseError>
  ) {
    this.errors = [...initialErrors]
  }

  parse(): ParseResult {
    const declarations = this.parseDeclarations(0)

    if (this.errors.length > 0) {
      return { ok: false, errors: this.errors }
    }

    return {
      ok: true,
      program: {
        _tag: "Program",
        line: declarations[0]?.line ?? 1,
        declarations
      }
    }
  }

  private current(): SourceLine | undefined {
    return this.lines[this.index]
  }

  private advance(): void {
    this.index += 1
  }

  private addError(line: number, message: string): void {
    this.errors.push({ line, message })
  }

  private matchStop(text: string, stopPrefixes: ReadonlyArray<string>): boolean {
    return stopPrefixes.some((prefix) => text.startsWith(prefix))
  }

  private parseDeclarations(
    indent: number,
    stopPrefixes: ReadonlyArray<string> = []
  ): Declaration[] {
    const declarations: Declaration[] = []

    while (true) {
      const line = this.current()
      if (!line) break
      if (line.indent < indent) break
      if (line.indent > indent) {
        this.addError(line.line, `Unexpected indentation at top level of block: ${line.text}`)
        this.advance()
        continue
      }
      if (this.matchStop(line.text, stopPrefixes)) {
        break
      }

      const declaration = this.parseDeclaration(indent)
      if (declaration) {
        declarations.push(declaration)
      }
    }

    return declarations
  }

  private parseDeclaration(indent: number): Declaration | undefined {
    const line = this.current()
    if (!line) return undefined

    if (line.text.startsWith("agent ")) return this.parseAgentDecl(indent)
    if (line.text.startsWith("let ") || line.text.startsWith("const ")) {
      return this.parseLetDecl()
    }
    if (line.text === "parallel:") return this.parseParallelBlock(indent)
    if (line.text.startsWith("loop until ")) return this.parseLoopUntilBlock(indent)
    if (line.text.startsWith("pipe ")) return this.parsePipeDecl()
    if (line.text.startsWith("if ")) return this.parseIfBlock(indent)
    if (line.text === "try:") return this.parseTryBlock(indent)
    if (this.isSessionHeader(line.text)) return this.parseSessionBlock(indent)
    if (this.isMapExpr(line.text)) return this.parseMapExpr()
    if (this.isReduceExpr(line.text)) return this.parseReduceExpr()

    this.addError(line.line, `Unknown declaration: ${line.text}`)
    this.advance()
    return undefined
  }

  private parseAgentDecl(indent: number): AgentDecl {
    const line = this.current()!
    const match = line.text.match(new RegExp(`^agent\\s+(${IDENT}):$`))
    if (!match) {
      this.addError(line.line, `Invalid agent declaration: ${line.text}`)
      this.advance()
      return { _tag: "AgentDecl", line: line.line, name: "__invalid__" }
    }

    let model: string | undefined
    let prompt: string | undefined
    let sandbox: AgentDecl["sandbox"]
    let writableRoots: ReadonlyArray<string> | undefined

    this.advance()

    while (true) {
      const next = this.current()
      if (!next || next.indent <= indent) break

      if (next.indent !== indent + 1) {
        this.addError(next.line, `Unexpected indentation in agent declaration: ${next.text}`)
        this.advance()
        continue
      }

      if (next.text.startsWith("model:")) {
        model = next.text.slice("model:".length).trim()
      } else if (next.text.startsWith("prompt:")) {
        prompt = next.text.slice("prompt:".length).trim()
      } else if (next.text.startsWith("sandbox:")) {
        const sandboxValue = next.text.slice("sandbox:".length).trim()
        if (sandboxValue === "read-only" || sandboxValue === "workspace-write") {
          sandbox = sandboxValue
        } else {
          this.addError(next.line, `Invalid sandbox value: ${sandboxValue}`)
        }
      } else if (next.text.startsWith("writableRoots:")) {
        try {
          writableRoots = parseBracketList(
            next.text.slice("writableRoots:".length).trim()
          )
        } catch (error) {
          this.addError(next.line, (error as Error).message)
        }
      } else {
        this.addError(next.line, `Unknown agent property: ${next.text}`)
      }

      this.advance()
    }

    return {
      _tag: "AgentDecl",
      line: line.line,
      name: match[1],
      model,
      prompt,
      sandbox,
      writableRoots
    }
  }

  private parseLetDecl(): LetDecl {
    const line = this.current()!
    const match = line.text.match(new RegExp(`^(let|const)\\s+(${IDENT})\\s*=\\s*"([\\s\\S]*)"$`))
    this.advance()

    if (!match) {
      this.addError(line.line, `Invalid variable declaration: ${line.text}`)
      return {
        _tag: "LetDecl",
        line: line.line,
        name: "__invalid__",
        value: "",
        constant: false
      }
    }

    return {
      _tag: "LetDecl",
      line: line.line,
      name: match[2],
      value: match[3],
      constant: match[1] === "const"
    }
  }

  private parseSessionBlock(indent: number): SessionBlock {
    const line = this.current()!
    const header = line.text.match(
      new RegExp(`^(?:(${IDENT})\\s*=\\s*)?session:\\s*(${IDENT})$`)
    )
    this.advance()

    if (!header) {
      this.addError(line.line, `Invalid session declaration: ${line.text}`)
      return {
        _tag: "SessionBlock",
        line: line.line,
        agent: "__invalid__",
        goal: ""
      }
    }

    const goalLines: string[] = []
    let max: number | undefined
    let dependsOn: ReadonlyArray<string> | undefined
    let evaluate: EvaluateAnnotation | undefined

    while (true) {
      const next = this.current()
      if (!next || next.indent <= indent) break

      if (next.indent > indent + 1 && this.isSessionMetadataKeyword(next.text)) {
        this.addError(next.line, `Unexpected indentation for session property: ${next.text}`)
        this.advance()
        continue
      }

      if (next.indent === indent + 1 && next.text.startsWith("max:")) {
        const value = Number.parseInt(next.text.slice("max:".length).trim(), 10)
        if (Number.isNaN(value)) {
          this.addError(next.line, `Invalid max value: ${next.text}`)
        } else {
          max = value
        }
        this.advance()
        continue
      }

      if (next.indent === indent + 1 && next.text.startsWith("depends_on:")) {
        try {
          dependsOn = parseBracketList(next.text.slice("depends_on:".length).trim())
        } catch (error) {
          this.addError(next.line, (error as Error).message)
        }
        this.advance()
        continue
      }

      if (next.indent === indent + 1 && next.text.startsWith("evaluate:")) {
        evaluate = this.parseEvaluateAnnotation()
        continue
      }

      goalLines.push(this.readGoalLine(next, indent + 1))
      this.advance()
    }

    if (goalLines.length === 0) {
      this.addError(line.line, "Session block requires at least one goal line")
    }

    return {
      _tag: "SessionBlock",
      line: line.line,
      varName: header[1],
      agent: header[2],
      goal: goalLines.join("\n"),
      max,
      dependsOn,
      evaluate
    }
  }

  private parseEvaluateAnnotation(): EvaluateAnnotation | undefined {
    const line = this.current()!
    const inline = line.text.slice("evaluate:".length).trim()
    this.advance()

    let who: string | undefined
    let args: Record<string, string> | undefined

    if (inline !== "") {
      const argsIndex = inline.indexOf(" args:")
      const whoPart = argsIndex >= 0 ? inline.slice(0, argsIndex).trim() : inline
      const argsPart = argsIndex >= 0 ? inline.slice(argsIndex + " args:".length).trim() : ""
      if (whoPart.startsWith("who:")) {
        who = whoPart.slice("who:".length).trim()
      } else {
        who = whoPart
      }
      if (argsPart !== "") {
        try {
          args = parseArgsObject(argsPart)
        } catch (error) {
          this.addError(line.line, (error as Error).message)
        }
      }
      return this.buildEvaluateAnnotation(line.line, who, args)
    }

    while (true) {
      const next = this.current()
      if (!next || next.indent <= line.indent) break

      if (next.indent !== line.indent + 1) {
        this.addError(next.line, `Unexpected indentation in evaluate block: ${next.text}`)
        this.advance()
        continue
      }

      if (next.text.startsWith("who:")) {
        who = next.text.slice("who:".length).trim()
      } else if (next.text.startsWith("args:")) {
        try {
          args = parseArgsObject(next.text.slice("args:".length).trim())
        } catch (error) {
          this.addError(next.line, (error as Error).message)
        }
      } else {
        this.addError(next.line, `Unknown evaluate property: ${next.text}`)
      }
      this.advance()
    }

    return this.buildEvaluateAnnotation(line.line, who, args)
  }

  private buildEvaluateAnnotation(
    line: number,
    who: string | undefined,
    args: Record<string, string> | undefined
  ): EvaluateAnnotation | undefined {
    if (!who) {
      this.addError(line, "Evaluate block requires `who:`")
      return undefined
    }
    if (who === "self") {
      return { _tag: "self" }
    }
    if (who.startsWith("agent:")) {
      const agentName = who.slice("agent:".length).trim()
      if (!identifierRegex.test(agentName)) {
        this.addError(line, `Invalid agent evaluator target: ${who}`)
        return undefined
      }
      return { _tag: "agent", agentName }
    }
    if (who.startsWith("check:")) {
      const checkName = who.slice("check:".length).trim()
      if (checkName === "") {
        this.addError(line, `Invalid check evaluator target: ${who}`)
        return undefined
      }
      return { _tag: "check", checkName, args }
    }

    this.addError(line, `Unknown evaluator target: ${who}`)
    return undefined
  }

  private parseParallelBlock(indent: number): ParallelBlock {
    const line = this.current()!
    this.advance()
    const sessions: SessionBlock[] = []

    while (true) {
      const next = this.current()
      if (!next || next.indent <= indent) break

      if (next.indent !== indent + 1) {
        this.addError(next.line, `Unexpected indentation in parallel block: ${next.text}`)
        this.advance()
        continue
      }

      if (!this.isSessionHeader(next.text)) {
        this.addError(next.line, `Parallel blocks may only contain sessions: ${next.text}`)
        this.advance()
        continue
      }

      sessions.push(this.parseSessionBlock(indent + 1))
    }

    if (sessions.length === 0) {
      this.addError(line.line, "Parallel block requires at least one session")
    }

    return {
      _tag: "ParallelBlock",
      line: line.line,
      sessions
    }
  }

  private parseLoopUntilBlock(indent: number): LoopUntilBlock {
    const line = this.current()!
    const match = line.text.match(/^loop until\s+\*\*(.+?)\*\*(?:\s+\(max:\s*(\d+)\))?:$/)
    this.advance()

    if (!match) {
      this.addError(line.line, `Invalid loop-until syntax: ${line.text}`)
      return {
        _tag: "LoopUntilBlock",
        line: line.line,
        condition: "",
        body: {
          _tag: "SessionBlock",
          line: line.line,
          agent: "__invalid__",
          goal: ""
        }
      }
    }

    let evaluate: EvaluateAnnotation | undefined
    if (
      this.current() &&
      this.current()!.indent === indent + 1 &&
      this.current()!.text.startsWith("evaluate:")
    ) {
      evaluate = this.parseEvaluateAnnotation()
    }

    const bodyLine = this.current()
    if (!bodyLine || bodyLine.indent !== indent + 1 || !this.isSessionHeader(bodyLine.text)) {
      this.addError(line.line, "Loop-until block requires a nested session")
      return {
        _tag: "LoopUntilBlock",
        line: line.line,
        condition: match[1],
        max: match[2] ? Number.parseInt(match[2], 10) : undefined,
        body: {
          _tag: "SessionBlock",
          line: line.line,
          agent: "__invalid__",
          goal: ""
        },
        evaluate
      }
    }

    const body = this.parseSessionBlock(indent + 1)

    if (
      this.current() &&
      this.current()!.indent === indent + 1 &&
      this.current()!.text.startsWith("evaluate:")
    ) {
      if (evaluate) {
        this.addError(this.current()!.line, "Duplicate loop-until evaluate block")
        this.parseEvaluateAnnotation()
      } else {
        evaluate = this.parseEvaluateAnnotation()
      }
    }

    while (this.current() && this.current()!.indent > indent) {
      this.addError(this.current()!.line, `Unexpected content in loop-until block: ${this.current()!.text}`)
      this.advance()
    }

    return {
      _tag: "LoopUntilBlock",
      line: line.line,
      condition: match[1],
      max: match[2] ? Number.parseInt(match[2], 10) : undefined,
      body,
      evaluate
    }
  }

  private parsePipeDecl(): PipeDecl {
    const line = this.current()!
    const match = line.text.match(
      new RegExp(
        `^pipe\\s+(${IDENT})\\s*->\\s*(${IDENT})\\s+on\\s+(iteration|done|both)\\s+via\\s+(context|notify|file)(?:\\s+(.+))?$`
      )
    )
    this.advance()

    if (!match) {
      this.addError(line.line, `Invalid pipe declaration: ${line.text}`)
      return {
        _tag: "PipeDecl",
        line: line.line,
        from: "__invalid__",
        to: "__invalid__",
        on: "done",
        strategy: { _tag: "context" }
      }
    }

    if (match[4] === "file" && !match[5]) {
      this.addError(line.line, "File pipe strategy requires a path")
    }

    return {
      _tag: "PipeDecl",
      line: line.line,
      from: match[1],
      to: match[2],
      on: match[3] as "iteration" | "done" | "both",
      strategy:
        match[4] === "context"
          ? { _tag: "context" }
          : match[4] === "notify"
            ? { _tag: "notify" }
            : { _tag: "file", path: match[5]?.trim() ?? "" }
    }
  }

  private parseIfBlock(indent: number): IfBlock {
    const line = this.current()!
    const match = line.text.match(/^if\s+\*\*(.+?)\*\*:\s*$/)
    this.advance()

    if (!match) {
      this.addError(line.line, `Invalid if syntax: ${line.text}`)
      return { _tag: "IfBlock", line: line.line, condition: "", then: [] }
    }

    let evaluate: EvaluateAnnotation | undefined
    if (
      this.current() &&
      this.current()!.indent === indent + 1 &&
      this.current()!.text.startsWith("evaluate:")
    ) {
      evaluate = this.parseEvaluateAnnotation()
    }

    const thenBody = this.parseDeclarations(indent + 1, ["elif ", "else:"])
    if (thenBody.length === 0) {
      this.addError(line.line, "If block requires at least one declaration in the then branch")
    }

    const elifs: IfBranch[] = []
    while (
      this.current() &&
      this.current()!.indent === indent &&
      this.current()!.text.startsWith("elif ")
    ) {
      const elifLine = this.current()!
      const elifMatch = elifLine.text.match(/^elif\s+\*\*(.+?)\*\*:\s*$/)
      this.advance()

      if (!elifMatch) {
        this.addError(elifLine.line, `Invalid elif syntax: ${elifLine.text}`)
        continue
      }

      const body = this.parseDeclarations(indent + 1, ["elif ", "else:"])
      if (body.length === 0) {
        this.addError(elifLine.line, "Elif branch requires at least one declaration")
      }

      elifs.push({
        line: elifLine.line,
        condition: elifMatch[1],
        body
      })
    }

    let elseBody: ReadonlyArray<Declaration> | undefined
    if (this.current() && this.current()!.indent === indent && this.current()!.text === "else:") {
      const elseLine = this.current()!
      this.advance()
      elseBody = this.parseDeclarations(indent + 1)
      if (elseBody.length === 0) {
        this.addError(elseLine.line, "Else branch requires at least one declaration")
      }
    }

    return {
      _tag: "IfBlock",
      line: line.line,
      condition: match[1],
      evaluate,
      then: thenBody,
      elifs: elifs.length > 0 ? elifs : undefined,
      else: elseBody
    }
  }

  private parseMapExpr(): MapExpr {
    const line = this.current()!
    const match = line.text.match(
      new RegExp(
        `^(?:(${IDENT})\\s*=\\s*)?(${IDENT})\\s*\\|\\s*(map|pmap):\\s*session(?:\\s+(${IDENT}))?\\s+"([\\s\\S]*)"$`
      )
    )
    this.advance()

    if (!match) {
      this.addError(line.line, `Invalid map expression: ${line.text}`)
      return {
        _tag: "MapExpr",
        line: line.line,
        items: "__invalid__",
        goal: "",
        parallel: false
      }
    }

    return {
      _tag: "MapExpr",
      line: line.line,
      items: match[2],
      agent: match[4],
      goal: match[5],
      varName: match[1],
      parallel: match[3] === "pmap"
    }
  }

  private parseReduceExpr(): ReduceExpr {
    const line = this.current()!
    const match = line.text.match(
      new RegExp(
        `^(?:(${IDENT})\\s*=\\s*)?(${IDENT})\\s*\\|\\s*reduce\\(\\s*(${IDENT})\\s*,\\s*(${IDENT})\\s*\\):\\s*session(?:\\s+(${IDENT}))?\\s+"([\\s\\S]*)"$`
      )
    )
    this.advance()

    if (!match) {
      this.addError(line.line, `Invalid reduce expression: ${line.text}`)
      return {
        _tag: "ReduceExpr",
        line: line.line,
        sources: [],
        goal: ""
      }
    }

    return {
      _tag: "ReduceExpr",
      line: line.line,
      sources: [match[2]],
      agent: match[5],
      goal: match[6],
      varName: match[1]
    }
  }

  private parseTryBlock(indent: number): TryBlock {
    const line = this.current()!
    this.advance()

    const body = this.parseDeclarations(indent + 1, ["catch:", "retry:", "backoff:"])
    if (body.length === 0) {
      this.addError(line.line, "Try block requires at least one declaration")
    }

    let catchBody: ReadonlyArray<Declaration> | undefined
    if (this.current() && this.current()!.indent === indent && this.current()!.text === "catch:") {
      const catchLine = this.current()!
      this.advance()
      catchBody = this.parseDeclarations(indent + 1, ["retry:", "backoff:"])
      if (catchBody.length === 0) {
        this.addError(catchLine.line, "Catch block requires at least one declaration")
      }
    }

    let retry: number | undefined
    let backoff: "linear" | "exponential" | undefined

    while (
      this.current() &&
      this.current()!.indent === indent &&
      (this.current()!.text.startsWith("retry:") || this.current()!.text.startsWith("backoff:"))
    ) {
      const next = this.current()!
      if (next.text.startsWith("retry:")) {
        const value = Number.parseInt(next.text.slice("retry:".length).trim(), 10)
        if (Number.isNaN(value)) {
          this.addError(next.line, `Invalid retry value: ${next.text}`)
        } else {
          retry = value
        }
      } else {
        const value = next.text.slice("backoff:".length).trim()
        if (value === "linear" || value === "exponential") {
          backoff = value
        } else {
          this.addError(next.line, `Invalid backoff value: ${value}`)
        }
      }
      this.advance()
    }

    return {
      _tag: "TryBlock",
      line: line.line,
      body,
      catchBody,
      retry,
      backoff
    }
  }

  private readGoalLine(line: SourceLine, baseIndent: number): string {
    return `${"  ".repeat(Math.max(0, line.indent - baseIndent))}${line.text}`
  }

  private isSessionMetadataKeyword(text: string): boolean {
    return (
      text.startsWith("max:") ||
      text.startsWith("depends_on:") ||
      text.startsWith("evaluate:")
    )
  }

  private isSessionHeader(text: string): boolean {
    return new RegExp(`^(?:${IDENT}\\s*=\\s*)?session:\\s*${IDENT}$`).test(text)
  }

  private isMapExpr(text: string): boolean {
    return text.includes("|") && /\|\s*(map|pmap):\s*session/.test(text)
  }

  private isReduceExpr(text: string): boolean {
    return text.includes("|") && /\|\s*reduce\(/.test(text)
  }
}

/** Parse a `.prose` file into an AST. */
export const parse = (source: string): ParseResult => {
  const preprocessed = preprocess(source)
  return new Parser(preprocessed.lines, preprocessed.errors).parse()
}
