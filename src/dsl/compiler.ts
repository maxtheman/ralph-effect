/**
 * compiler.ts — Compile OpenProse ASTs into Effect programs over the Orchestrator service.
 *
 * Takes ASTs produced by the OpenProse parser and emits typed Effect programs
 * that call the ralph orchestrator API. The OpenProse language specification
 * is at: https://github.com/openprose/prose (MIT license, copyright OpenProse).
 */
import { Effect, Either } from "effect"
import type {
  Declaration,
  EvaluateAnnotation,
  IfBlock,
  LoopUntilBlock,
  MapExpr,
  PipeDecl,
  PipelineBlock,
  Program,
  ReduceExpr,
  SessionBlock,
  TryBlock
} from "./ast.js"
import { Orchestrator } from "../orchestrator.js"
import type { AgentConfig, LoopConfig } from "../loop-types.js"
import { builtinChecks, builtinCheckSpecs } from "./checks.js"
import { evaluateCondition, resolveEvaluator, resolveSemanticEvaluator } from "./evaluators.js"

export interface CompileError {
  readonly line: number
  readonly message: string
}

export type CompileResult =
  | { readonly ok: true; readonly effect: Effect.Effect<void, Error, Orchestrator> }
  | { readonly ok: false; readonly errors: ReadonlyArray<CompileError> }

interface CompileState {
  readonly agents: Map<string, AgentConfig>
  readonly vars: Map<string, string>
  readonly resultSets: Map<string, ReadonlyArray<string>>
  readonly sessionIds: Map<string, number>
  readonly implicitAgentNames: string[]
  errors: CompileError[]
  implicitAgentCursor: number
}

interface DependencyNode {
  readonly deps: ReadonlyArray<string>
  readonly line: number
}

const VARIABLE_PATTERN = /\{\{([A-Za-z_][A-Za-z0-9_-]*)\}\}/g

const addError = (state: CompileState, line: number, message: string): void => {
  state.errors = [...state.errors, { line, message }]
}

const mergeErrors = (state: CompileState, child: CompileState): void => {
  if (child.errors.length === 0) {
    return
  }
  state.errors = [...state.errors, ...child.errors]
}

const cloneState = (state: CompileState): CompileState => ({
  agents: new Map(state.agents),
  vars: new Map(state.vars),
  resultSets: new Map(state.resultSets),
  sessionIds: new Map(state.sessionIds),
  implicitAgentNames: [...state.implicitAgentNames],
  errors: [],
  implicitAgentCursor: state.implicitAgentCursor
})

const interpolate = (text: string, line: number, state: CompileState): string =>
  text.replace(VARIABLE_PATTERN, (_match, name: string) => {
    const value = state.vars.get(name)
    if (value === undefined) {
      addError(state, line, `Undefined variable: ${name}`)
      return `{{${name}}}`
    }
    return value
  })

const interpolateArgs = (
  args: Record<string, string> | undefined,
  line: number,
  state: CompileState
): Record<string, string> | undefined => {
  if (!args) {
    return undefined
  }

  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(args)) {
    result[key] = interpolate(value, line, state)
  }
  return result
}

const validateCheckArgs = (
  checkName: string,
  args: Record<string, string> | undefined,
  line: number,
  state: CompileState
): boolean => {
  const spec = builtinCheckSpecs[checkName]
  if (!spec) {
    addError(state, line, `Unknown check: ${checkName}`)
    return false
  }

  let valid = true
  for (const requiredArg of spec.requiredArgs ?? []) {
    const value = args?.[requiredArg]?.trim()
    if (!value) {
      addError(state, line, `Check \`${checkName}\` requires args.${requiredArg}`)
      valid = false
    }
  }
  return valid
}

const normalizeAnnotation = (
  annotation: EvaluateAnnotation | undefined,
  line: number,
  state: CompileState
): EvaluateAnnotation | undefined => {
  if (!annotation || annotation._tag === "self") {
    return annotation
  }

  if (annotation._tag === "agent") {
    if (!state.agents.has(annotation.agentName)) {
      addError(state, line, `Unknown agent: ${annotation.agentName}`)
      return undefined
    }
    return annotation
  }

  if (!(annotation.checkName in builtinChecks)) {
    addError(state, line, `Unknown check: ${annotation.checkName}`)
    return undefined
  }

  const args = interpolateArgs(annotation.args, line, state)
  if (!validateCheckArgs(annotation.checkName, args, line, state)) {
    return undefined
  }

  return {
    _tag: "check",
    checkName: annotation.checkName,
    args
  }
}

const sessionIdOf = (session: SessionBlock): string => session.varName ?? session.agent

const reduceIdOf = (reduceExpr: ReduceExpr): string =>
  reduceExpr.varName ?? reduceExpr.agent ?? `reduce_${reduceExpr.line}`

const collectScopeStatics = (
  declarations: ReadonlyArray<Declaration>,
  state: CompileState
): void => {
  for (const declaration of declarations) {
    switch (declaration._tag) {
      case "AgentDecl":
        state.agents.set(declaration.name, {
          personality: declaration.prompt,
          sandbox: declaration.sandbox,
          writableRoots: declaration.writableRoots ? [...declaration.writableRoots] : undefined,
          model: declaration.model,
          reasoningEffort: declaration.reasoningEffort
        })
        if (!state.implicitAgentNames.includes(declaration.name)) {
          state.implicitAgentNames.push(declaration.name)
        }
        break
      case "LetDecl":
        state.vars.set(declaration.name, declaration.value)
        break
      default:
        break
    }
  }
}

const collectSessionIds = (declarations: ReadonlyArray<Declaration>, state: CompileState): void => {
  for (const declaration of declarations) {
    switch (declaration._tag) {
      case "SessionBlock": {
        const id = sessionIdOf(declaration)
        if (state.sessionIds.has(id)) {
          addError(state, declaration.line, `Duplicate session identifier: ${id}`)
        } else {
          state.sessionIds.set(id, declaration.line)
        }
        break
      }
      case "ParallelBlock":
        collectSessionIds(declaration.sessions, state)
        break
      case "LoopUntilBlock": {
        if (declaration.body._tag === "SessionBlock") {
          const id = sessionIdOf(declaration.body)
          if (state.sessionIds.has(id)) {
            addError(state, declaration.line, `Duplicate session identifier: ${id}`)
          } else {
            state.sessionIds.set(id, declaration.line)
          }
        } else {
          // PipelineBlock body: recurse into its declarations
          collectSessionIds(declaration.body.declarations, state)
        }
        break
      }
      case "PipelineBlock":
        collectSessionIds(declaration.declarations, state)
        break
      case "ReduceExpr": {
        const id = reduceIdOf(declaration)
        if (state.sessionIds.has(id)) {
          addError(state, declaration.line, `Duplicate session identifier: ${id}`)
        } else {
          state.sessionIds.set(id, declaration.line)
        }
        break
      }
      case "IfBlock":
        collectSessionIds(declaration.then, state)
        for (const branch of declaration.elifs ?? []) {
          collectSessionIds(branch.body, state)
        }
        if (declaration.else) {
          collectSessionIds(declaration.else, state)
        }
        break
      case "TryBlock":
        collectSessionIds(declaration.body, state)
        if (declaration.catchBody) {
          collectSessionIds(declaration.catchBody, state)
        }
        break
      default:
        break
    }
  }
}

const validateDependencies = (
  declarations: ReadonlyArray<Declaration>,
  state: CompileState,
  graph: Map<string, DependencyNode>
): void => {
  for (const declaration of declarations) {
    switch (declaration._tag) {
      case "SessionBlock": {
        const id = sessionIdOf(declaration)
        const deps = declaration.dependsOn ?? []
        graph.set(id, { deps, line: declaration.line })
        for (const dep of deps) {
          if (!state.sessionIds.has(dep)) {
            addError(state, declaration.line, `Unknown dependency: ${dep}`)
          }
        }
        break
      }
      case "ParallelBlock":
        validateDependencies(declaration.sessions, state, graph)
        break
      case "LoopUntilBlock": {
        if (declaration.body._tag === "SessionBlock") {
          const id = sessionIdOf(declaration.body)
          const deps = declaration.body.dependsOn ?? []
          graph.set(id, { deps, line: declaration.line })
          for (const dep of deps) {
            if (!state.sessionIds.has(dep)) {
              addError(state, declaration.line, `Unknown dependency: ${dep}`)
            }
          }
        } else {
          // PipelineBlock body: validate dependencies within the pipeline
          validateDependencies(declaration.body.declarations, state, graph)
        }
        break
      }
      case "PipelineBlock":
        validateDependencies(declaration.declarations, state, graph)
        break
      case "PipeDecl":
        if (!state.sessionIds.has(declaration.from)) {
          addError(state, declaration.line, `Unknown pipe source: ${declaration.from}`)
        }
        if (!state.sessionIds.has(declaration.to)) {
          addError(state, declaration.line, `Unknown pipe target: ${declaration.to}`)
        }
        if (declaration.from === declaration.to) {
          addError(state, declaration.line, "Cannot pipe a session to itself")
        }
        break
      case "IfBlock":
        validateDependencies(declaration.then, state, graph)
        for (const branch of declaration.elifs ?? []) {
          validateDependencies(branch.body, state, graph)
        }
        if (declaration.else) {
          validateDependencies(declaration.else, state, graph)
        }
        break
      case "TryBlock":
        validateDependencies(declaration.body, state, graph)
        if (declaration.catchBody) {
          validateDependencies(declaration.catchBody, state, graph)
        }
        break
      default:
        break
    }
  }
}

const detectCycles = (
  graph: ReadonlyMap<string, DependencyNode>,
  state: CompileState
): void => {
  const visiting = new Set<string>()
  const visited = new Set<string>()

  const visit = (node: string, path: string[], line: number): void => {
    if (visited.has(node)) {
      return
    }
    if (visiting.has(node)) {
      const cycleStart = path.indexOf(node)
      const cycle = [...path.slice(cycleStart), node].join(" -> ")
      addError(state, line, `Circular dependency detected: ${cycle}`)
      return
    }

    visiting.add(node)
    for (const dep of graph.get(node)?.deps ?? []) {
      if (graph.has(dep)) {
        visit(dep, [...path, node], graph.get(node)?.line ?? line)
      }
    }
    visiting.delete(node)
    visited.add(node)
  }

  for (const node of graph.keys()) {
    visit(node, [], graph.get(node)?.line ?? 1)
  }
}

const resolveAgentName = (
  rawAgent: string | undefined,
  line: number,
  state: CompileState,
  purpose: string
): string | undefined => {
  if (rawAgent) {
    return rawAgent
  }

  const inferred = state.implicitAgentNames[state.implicitAgentCursor]
  if (!inferred) {
    addError(state, line, `Unable to infer agent for ${purpose}`)
    return undefined
  }
  state.implicitAgentCursor += 1
  return inferred
}

const resolveAgentConfig = (
  agentName: string | undefined,
  line: number,
  state: CompileState
): AgentConfig | undefined => {
  if (!agentName) {
    return undefined
  }

  const config = state.agents.get(agentName)
  if (!config) {
    addError(state, line, `Unknown agent: ${agentName}`)
    return undefined
  }
  return config
}

const safeResolveEvaluator = (
  annotation: EvaluateAnnotation | undefined,
  line: number,
  state: CompileState
): LoopConfig["evaluator"] | undefined => {
  if (!annotation) {
    return undefined
  }

  try {
    return resolveEvaluator(annotation, state.agents)
  } catch (error) {
    addError(state, line, (error as Error).message)
    return undefined
  }
}

const safeResolveSemanticEvaluator = (
  condition: string,
  annotation: EvaluateAnnotation | undefined,
  line: number,
  state: CompileState
): LoopConfig["evaluator"] => {
  try {
    return resolveSemanticEvaluator(condition, annotation, state.agents)
  } catch (error) {
    addError(state, line, (error as Error).message)
    return () => Effect.succeed({ done: false, reason: "Invalid evaluator" })
  }
}

const buildLoopConfig = (
  session: SessionBlock,
  state: CompileState,
  overrides?: {
    readonly maxIterations?: number
    readonly evaluator?: LoopConfig["evaluator"]
    readonly annotation?: EvaluateAnnotation
  }
): LoopConfig => {
  const annotation = overrides?.annotation ?? normalizeAnnotation(session.evaluate, session.line, state)

  return {
    id: sessionIdOf(session),
    goal: interpolate(session.goal, session.line, state),
    maxIterations: overrides?.maxIterations ?? session.max ?? Infinity,
    verbose: true,
    agent: resolveAgentConfig(session.agent, session.line, state),
    evaluator: overrides?.evaluator ?? safeResolveEvaluator(annotation, session.line, state)
  }
}

const compileSession = (
  session: SessionBlock,
  state: CompileState
): Effect.Effect<void, Error, Orchestrator> => {
  const config = buildLoopConfig(session, state)
  const deps = session.dependsOn ?? []

  return Effect.gen(function* () {
    const orch = yield* Orchestrator
    if (deps.length > 0) {
      yield* orch.forkAfter(config, deps)
    } else {
      yield* orch.fork(config)
    }
  })
}

const compilePipe = (
  pipe: PipeDecl,
  state: CompileState
): Effect.Effect<void, Error, Orchestrator> => {
  const strategy =
    pipe.strategy._tag === "file"
      ? { _tag: "file" as const, path: interpolate(pipe.strategy.path, pipe.line, state) }
      : pipe.strategy

  return Effect.gen(function* () {
    const orch = yield* Orchestrator
    yield* orch.pipe({
      from: pipe.from,
      to: pipe.to,
      on: pipe.on,
      strategy
    })
  })
}

/** Collect session IDs that will be forked directly by a pipeline body. */
const collectPipelineSessionIds = (declarations: ReadonlyArray<Declaration>): string[] => {
  const ids: string[] = []
  for (const decl of declarations) {
    switch (decl._tag) {
      case "SessionBlock":
        ids.push(sessionIdOf(decl))
        break
      case "ParallelBlock":
        for (const s of decl.sessions) {
          ids.push(sessionIdOf(s))
        }
        break
      case "LoopUntilBlock":
        // Only include session-body loops (pipeline-body loops manage their own awaiting)
        if (decl.body._tag === "SessionBlock") {
          ids.push(sessionIdOf(decl.body))
        }
        break
      default:
        break
    }
  }
  return ids
}

const compileLoopUntil = (
  loop: LoopUntilBlock,
  state: CompileState
): Effect.Effect<void, Error, Orchestrator> => {
  const condition = interpolate(loop.condition, loop.line, state)

  // ---------------------------------------------------------------------------
  // Pipeline body: multi-agent iteration loop
  // ---------------------------------------------------------------------------
  if (loop.body._tag === "PipelineBlock") {
    const pipelineState = cloneState(state)
    // Pre-collect statics so evaluator resolution can see pipeline-scoped agents
    collectScopeStatics(loop.body.declarations, pipelineState)

    const annotation = normalizeAnnotation(loop.evaluate, loop.line, pipelineState)
    const evaluator = safeResolveSemanticEvaluator(condition, annotation, loop.line, pipelineState)
    mergeErrors(state, pipelineState)

    // Compile the pipeline body into a reusable Effect
    const bodyEffect = compileScope(loop.body.declarations, pipelineState)
    mergeErrors(state, pipelineState)

    const sessionIds = collectPipelineSessionIds(loop.body.declarations)
    const max = loop.max ?? Infinity

    return Effect.gen(function* () {
      const orch = yield* Orchestrator

      for (let iteration = 0; iteration < max; iteration++) {
        // Fork all pipeline sessions, register pipes, etc.
        yield* bodyEffect

        // Wait for all pipeline sessions to reach terminal state
        yield* orch.awaitIds(sessionIds)

        // Collect outputs from completed sessions for evaluation
        const statuses = yield* Effect.all(
          sessionIds.map((id) => orch.status(id))
        )
        const combinedOutput = statuses
          .map((s) => `[${s.id}]: ${s.lastAgentOutput}`)
          .join("\n---\n")

        // Evaluate the semantic condition (evaluator is always defined from safeResolveSemanticEvaluator)
        const evalResult = yield* evaluator!(condition, combinedOutput)
        if (evalResult.done) break
        // Next iteration: idempotent IDs reclaim terminal loops automatically
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Session body: original single-session loop (ralph handles iteration)
  // ---------------------------------------------------------------------------
  const annotation = normalizeAnnotation(loop.evaluate ?? loop.body.evaluate, loop.line, state)
  const evaluator = safeResolveSemanticEvaluator(condition, annotation, loop.line, state)
  const config = buildLoopConfig(loop.body, state, {
    maxIterations: loop.max ?? loop.body.max ?? 10,
    evaluator,
    annotation
  })
  const deps = loop.body.dependsOn ?? []

  return Effect.gen(function* () {
    const orch = yield* Orchestrator
    if (deps.length > 0) {
      yield* orch.forkAfter(config, deps)
    } else {
      yield* orch.fork(config)
    }
  })
}

const compileParallel = (
  sessions: ReadonlyArray<SessionBlock>,
  state: CompileState
): Effect.Effect<void, Error, Orchestrator> => compileScope(sessions, state)

const splitItems = (value: string): ReadonlyArray<string> =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

const compileMap = (
  mapExpr: MapExpr,
  state: CompileState
): Effect.Effect<void, Error, Orchestrator> => {
  const agentName = resolveAgentName(mapExpr.agent, mapExpr.line, state, "map expression")
  const agentConfig = resolveAgentConfig(agentName, mapExpr.line, state)
  const itemsValue = state.vars.get(mapExpr.items)
  if (itemsValue === undefined) {
    addError(state, mapExpr.line, `Undefined items variable: ${mapExpr.items}`)
  }

  const items = splitItems(itemsValue ?? "")
  const ids = items.map((_, index) => `${mapExpr.varName ?? mapExpr.items}_${index + 1}`)
  const goals = items.map((item) =>
    interpolate(mapExpr.goal.replace(/\{\{item\}\}/g, item), mapExpr.line, state)
  )

  if (mapExpr.varName) {
    state.resultSets.set(mapExpr.varName, ids)
  }

  const configs = goals.map<LoopConfig>((goal, index) => ({
    id: ids[index],
    goal,
    maxIterations: Infinity,
    verbose: true,
    agent: agentConfig
  }))

  return Effect.gen(function* () {
    const orch = yield* Orchestrator
    let previousId: string | undefined

    for (const config of configs) {
      if (!mapExpr.parallel && previousId) {
        yield* orch.forkAfter(config, [previousId])
      } else {
        yield* orch.fork(config)
      }
      previousId = config.id
    }
  })
}

const resolveReduceSources = (
  reduceExpr: ReduceExpr,
  state: CompileState
): ReadonlyArray<string> => {
  const sources: string[] = []

  for (const source of reduceExpr.sources) {
    if (state.resultSets.has(source)) {
      sources.push(...(state.resultSets.get(source) ?? []))
      continue
    }
    if (state.sessionIds.has(source)) {
      sources.push(source)
      continue
    }
    addError(state, reduceExpr.line, `Unknown reduce source: ${source}`)
  }

  return sources
}

const compileReduce = (
  reduceExpr: ReduceExpr,
  state: CompileState
): Effect.Effect<void, Error, Orchestrator> => {
  const agentName = resolveAgentName(reduceExpr.agent, reduceExpr.line, state, "reduce expression")
  const agentConfig = resolveAgentConfig(agentName, reduceExpr.line, state)
  const reducerId = reduceIdOf(reduceExpr)
  const goal = interpolate(reduceExpr.goal, reduceExpr.line, state)
  const sources = resolveReduceSources(reduceExpr, state)

  if (reduceExpr.varName) {
    state.resultSets.set(reduceExpr.varName, [reducerId])
  }

  const reducer: LoopConfig = {
    id: reducerId,
    goal,
    maxIterations: Infinity,
    verbose: true,
    agent: agentConfig
  }

  return Effect.gen(function* () {
    const orch = yield* Orchestrator
    yield* orch.reduce({ sources, reducer })
  })
}

type TopologyManagedDeclaration = SessionBlock | LoopUntilBlock

const isTopologyManagedDeclaration = (
  declaration: Declaration
): declaration is TopologyManagedDeclaration =>
  declaration._tag === "SessionBlock" ||
  (declaration._tag === "LoopUntilBlock" && declaration.body._tag === "SessionBlock")

const topologyIdOf = (declaration: TopologyManagedDeclaration): string => {
  if (declaration._tag === "SessionBlock") return sessionIdOf(declaration)
  // isTopologyManagedDeclaration guarantees body is SessionBlock
  const body = declaration.body as SessionBlock
  return sessionIdOf(body)
}

const topologyDepsOf = (
  declaration: TopologyManagedDeclaration
): ReadonlyArray<string> => {
  if (declaration._tag === "SessionBlock") return declaration.dependsOn ?? []
  // isTopologyManagedDeclaration guarantees body is SessionBlock
  const body = declaration.body as SessionBlock
  return body.dependsOn ?? []
}

const orderScopeDeclarations = (
  declarations: ReadonlyArray<Declaration>
): ReadonlyArray<Declaration> => {
  const sortable = declarations.filter(isTopologyManagedDeclaration)
  if (sortable.length < 2) {
    return declarations
  }

  const localIds = new Set(sortable.map((declaration) => topologyIdOf(declaration)))
  const originalOrder = new Map<Declaration, number>()
  declarations.forEach((declaration, index) => {
    originalOrder.set(declaration, index)
  })

  const indegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()
  const declarationById = new Map<string, TopologyManagedDeclaration>()

  for (const declaration of sortable) {
    const id = topologyIdOf(declaration)
    declarationById.set(id, declaration)
    indegree.set(id, 0)
    adjacency.set(id, [])
  }

  for (const declaration of sortable) {
    const id = topologyIdOf(declaration)
    for (const dep of topologyDepsOf(declaration)) {
      if (!localIds.has(dep)) {
        continue
      }
      adjacency.get(dep)!.push(id)
      indegree.set(id, (indegree.get(id) ?? 0) + 1)
    }
  }

  const ready = Array.from(declarationById.values())
    .filter((declaration) => (indegree.get(topologyIdOf(declaration)) ?? 0) === 0)
    .sort((left, right) => (originalOrder.get(left) ?? 0) - (originalOrder.get(right) ?? 0))

  const sorted: TopologyManagedDeclaration[] = []

  while (ready.length > 0) {
    const next = ready.shift()!
    sorted.push(next)

    for (const dependentId of adjacency.get(topologyIdOf(next)) ?? []) {
      const nextDegree = (indegree.get(dependentId) ?? 0) - 1
      indegree.set(dependentId, nextDegree)
      if (nextDegree === 0) {
        ready.push(declarationById.get(dependentId)!)
        ready.sort(
          (left, right) => (originalOrder.get(left) ?? 0) - (originalOrder.get(right) ?? 0)
        )
      }
    }
  }

  if (sorted.length !== sortable.length) {
    return declarations
  }

  let index = 0
  return declarations.map((declaration) =>
    isTopologyManagedDeclaration(declaration) ? sorted[index++] : declaration
  )
}

const compileIf = (
  ifBlock: IfBlock,
  state: CompileState
): Effect.Effect<void, Error, Orchestrator> => {
  const firstCondition = interpolate(ifBlock.condition, ifBlock.line, state)
  const annotation = normalizeAnnotation(ifBlock.evaluate, ifBlock.line, state)

  const thenState = cloneState(state)
  const thenEffect = compileScope(ifBlock.then, thenState)
  mergeErrors(state, thenState)

  const elifs = (ifBlock.elifs ?? []).map((branch) => {
    const branchState = cloneState(state)
    const effect = compileScope(branch.body, branchState)
    mergeErrors(state, branchState)
    return {
      condition: interpolate(branch.condition, branch.line, state),
      effect
    }
  })

  const elseState = ifBlock.else ? cloneState(state) : undefined
  const elseEffect = ifBlock.else && elseState ? compileScope(ifBlock.else, elseState) : undefined
  if (elseState) {
    mergeErrors(state, elseState)
  }

  return Effect.gen(function* () {
    if (yield* evaluateCondition(firstCondition, annotation, state.agents)) {
      yield* thenEffect
      return
    }

    for (const branch of elifs) {
      if (yield* evaluateCondition(branch.condition, annotation, state.agents)) {
        yield* branch.effect
        return
      }
    }

    if (elseEffect) {
      yield* elseEffect
    }
  })
}

const retryDelay = (
  retryCount: number,
  backoff: TryBlock["backoff"]
): `${number} millis` => {
  const base = 250
  const millis =
    backoff === "exponential" ? base * 2 ** Math.max(0, retryCount - 1) : base * retryCount
  return `${millis} millis`
}

const compileTry = (
  tryBlock: TryBlock,
  state: CompileState
): Effect.Effect<void, Error, Orchestrator> => {
  const bodyState = cloneState(state)
  const bodyEffect = compileScope(tryBlock.body, bodyState)
  mergeErrors(state, bodyState)

  const catchState = tryBlock.catchBody ? cloneState(state) : undefined
  const catchEffect =
    tryBlock.catchBody && catchState ? compileScope(tryBlock.catchBody, catchState) : undefined
  if (catchState) {
    mergeErrors(state, catchState)
  }

  const retried = Effect.gen(function* () {
    const retries = tryBlock.retry ?? 0
    let attempt = 0
    let lastError: Error | undefined

    while (attempt <= retries) {
      const result = yield* Effect.either(bodyEffect)
      if (Either.isRight(result)) {
        return
      }

      lastError = result.left
      attempt += 1
      if (attempt > retries) {
        break
      }
      yield* Effect.sleep(retryDelay(attempt, tryBlock.backoff))
    }

    return yield* Effect.fail(lastError ?? new Error("Try block failed"))
  })

  if (!catchEffect) {
    return retried
  }

  return retried.pipe(Effect.catchAll(() => catchEffect))
}

const compileDeclaration = (
  declaration: Declaration,
  state: CompileState
): Effect.Effect<void, Error, Orchestrator> => {
  switch (declaration._tag) {
    case "AgentDecl":
    case "LetDecl":
      return Effect.void
    case "SessionBlock":
      return compileSession(declaration, state)
    case "ParallelBlock":
      return compileParallel(declaration.sessions, state)
    case "LoopUntilBlock":
      return compileLoopUntil(declaration, state)
    case "PipelineBlock": {
      const pipeState = cloneState(state)
      const eff = compileScope(declaration.declarations, pipeState)
      mergeErrors(state, pipeState)
      return eff
    }
    case "PipeDecl":
      return compilePipe(declaration, state)
    case "IfBlock":
      return compileIf(declaration, state)
    case "MapExpr":
      return compileMap(declaration, state)
    case "ReduceExpr":
      return compileReduce(declaration, state)
    case "TryBlock":
      return compileTry(declaration, state)
  }
}

const compileScope = (
  declarations: ReadonlyArray<Declaration>,
  state: CompileState
): Effect.Effect<void, Error, Orchestrator> => {
  collectScopeStatics(declarations, state)
  const orderedDeclarations = orderScopeDeclarations(declarations)
  const effects = orderedDeclarations.map((declaration) => compileDeclaration(declaration, state))

  return Effect.gen(function* () {
    for (const effect of effects) {
      yield* effect
    }
  })
}

/** Compile a parsed AST into an Effect that drives the orchestrator. */
export const compile = (program: Program): CompileResult => {
  const state: CompileState = {
    agents: new Map<string, AgentConfig>(),
    vars: new Map<string, string>(),
    resultSets: new Map<string, ReadonlyArray<string>>(),
    sessionIds: new Map<string, number>(),
    implicitAgentNames: [],
    errors: [],
    implicitAgentCursor: 0
  }

  collectSessionIds(program.declarations, state)

  const graph = new Map<string, DependencyNode>()
  validateDependencies(program.declarations, state, graph)
  detectCycles(graph, state)

  const effect = compileScope(program.declarations, state).pipe(
    Effect.flatMap(() =>
      Effect.gen(function* () {
        const orch = yield* Orchestrator
        yield* orch.awaitAll()
      })
    )
  )

  if (state.errors.length > 0) {
    return { ok: false, errors: state.errors }
  }

  return { ok: true, effect }
}
