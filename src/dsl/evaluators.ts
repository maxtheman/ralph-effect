/**
 * evaluators.ts — Routing from `evaluate:` annotations to executable evaluators.
 *
 * Implements evaluator resolution for the OpenProse `evaluate:` syntax.
 * OpenProse language spec: https://github.com/openprose/prose (MIT license).
 */
import { Effect } from "effect"
import { CodexLLM, CodexLLMLive } from "../codex-client.js"
import type { AgentConfig, EvalResult, Evaluator } from "../loop-types.js"
import type { EvaluateAnnotation } from "./ast.js"
import { builtinChecks } from "./checks.js"

const parseJudgeVerdict = (text: string): EvalResult => {
  const lines = text.trim().split("\n")
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === "DONE" || trimmed.startsWith("DONE")) {
      return { done: true, reason: "complete" }
    }
    if (trimmed.startsWith("FAILED")) {
      return { done: false, reason: trimmed }
    }
    if (trimmed.startsWith("CONTINUE:")) {
      return { done: false, reason: trimmed.slice("CONTINUE:".length).trim() || "continue" }
    }
  }
  return {
    done: false,
    reason: text.trim().slice(0, 200) || "Unable to determine completion"
  }
}

const withCodex = <A>(use: (codex: CodexLLM["Type"]) => Effect.Effect<A, Error>) =>
  Effect.gen(function* () {
    const codex = yield* CodexLLM
    return yield* use(codex).pipe(
      Effect.ensuring(codex.shutdown().pipe(Effect.catchAll(() => Effect.void)))
    )
  }).pipe(Effect.provide(CodexLLMLive))

const runPrompt = (prompt: string, config?: AgentConfig): Effect.Effect<string, Error> =>
  withCodex((codex) =>
    config
      ? Effect.gen(function* () {
          const threadId = yield* codex.createThread(config)
          return yield* codex.sendTurn(threadId, prompt).pipe(
            Effect.ensuring(
              codex.archiveThread(threadId).pipe(Effect.catchAll(() => Effect.void))
            )
          )
        })
      : codex.generateText(prompt)
  )

const goalPrompt = (goal: string, output: string): string => `You are a strict evaluator.

Determine whether the agent output achieved the goal below.

GOAL:
${goal}

AGENT OUTPUT:
${output}

Do not run tools or verify anything yourself. Your entire response must be exactly one line:
DONE
CONTINUE: <what still needs to be done>
FAILED: <reason>`

const semanticPrompt = (condition: string, output: string): string => `You are a strict evaluator.

Determine whether the semantic condition below is satisfied.

CONDITION:
${condition}

EVIDENCE:
${output}

Do not run tools or verify anything yourself. Your entire response must be exactly one line:
DONE
CONTINUE: <why the condition is not yet satisfied>
FAILED: <reason>`

const conditionPrompt = (condition: string): string => `You are a strict evaluator.

Determine whether the statement below is currently true.

STATEMENT:
${condition}

If you cannot justify DONE from the statement alone, respond with CONTINUE.
Your entire response must be exactly one line:
DONE
CONTINUE: <why it is not established>
FAILED: <reason>`

const resolveAgentConfig = (
  agentName: string,
  agents: ReadonlyMap<string, AgentConfig>
): AgentConfig => {
  const config = agents.get(agentName)
  if (!config) {
    throw new Error(`Unknown agent: ${agentName}`)
  }
  return config
}

const buildGoalEvaluator = (config?: AgentConfig): Evaluator => (goal, output) =>
  runPrompt(goalPrompt(goal, output), config).pipe(Effect.map(parseJudgeVerdict))

const buildSemanticEvaluator = (condition: string, config?: AgentConfig): Evaluator =>
  (_goal, output) =>
    runPrompt(semanticPrompt(condition, output), config).pipe(Effect.map(parseJudgeVerdict))

/** Resolve a session-level `evaluate:` annotation to an Evaluator function. */
export const resolveEvaluator = (
  annotation: EvaluateAnnotation,
  agents: ReadonlyMap<string, AgentConfig>
): Evaluator | undefined => {
  switch (annotation._tag) {
    case "self":
      return undefined
    case "agent":
      return buildGoalEvaluator(resolveAgentConfig(annotation.agentName, agents))
    case "check": {
      const checkFn = builtinChecks[annotation.checkName]
      if (!checkFn) {
        throw new Error(`Unknown check: ${annotation.checkName}`)
      }
      return checkFn(annotation.args ?? {})
    }
  }
}

/** Resolve a semantic condition to an evaluator for loop-until blocks. */
export const resolveSemanticEvaluator = (
  condition: string,
  annotation: EvaluateAnnotation | undefined,
  agents: ReadonlyMap<string, AgentConfig>
): Evaluator => {
  if (!annotation || annotation._tag === "self") {
    return buildSemanticEvaluator(condition)
  }
  if (annotation._tag === "agent") {
    return buildSemanticEvaluator(condition, resolveAgentConfig(annotation.agentName, agents))
  }

  const checkFn = builtinChecks[annotation.checkName]
  if (!checkFn) {
    throw new Error(`Unknown check: ${annotation.checkName}`)
  }
  return checkFn(annotation.args ?? {})
}

/** Evaluate an `if` condition immediately at runtime. */
export const evaluateCondition = (
  condition: string,
  annotation: EvaluateAnnotation | undefined,
  agents: ReadonlyMap<string, AgentConfig>
): Effect.Effect<boolean, Error> => {
  if (annotation?._tag === "check") {
    const checkFn = builtinChecks[annotation.checkName]
    if (!checkFn) {
      return Effect.fail(new Error(`Unknown check: ${annotation.checkName}`))
    }
    return checkFn(annotation.args ?? {})("", "").pipe(Effect.map((result) => result.done))
  }

  if (annotation?._tag === "agent") {
    return runPrompt(conditionPrompt(condition), resolveAgentConfig(annotation.agentName, agents)).pipe(
      Effect.map((text) => parseJudgeVerdict(text).done)
    )
  }

  return runPrompt(conditionPrompt(condition)).pipe(
    Effect.map((text) => parseJudgeVerdict(text).done)
  )
}
