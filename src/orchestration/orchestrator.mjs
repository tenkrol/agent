/**
 * Оркестратор задачи (этап 1, PLA-19).
 *
 * Единственный владелец цикла исполнение → проверка → исправление. Получает
 * готовый контекст от адаптера входа (бот), исполнителя из реестра и порт
 * проверки. Не знает Telegram, HTTP, GitHub и `core/bot.mjs`; побочные действия
 * (доставка, файлы, парковка вопроса) остаются адаптеру.
 */
import { createBudget, minLimit } from './budget.mjs'
import { createExecutorRegistry } from './registry.mjs'
import { STAGE, classifyOutcome } from './lifecycle.mjs'

const EMPTY_USAGE = () => ({ totalTokens: undefined, steps: undefined, unknown: true })

const failedFeedback = (verification) => (verification?.criteria ?? [])
  .filter((criterion) => criterion.status !== 'passed')
  .map((criterion) => `- ${criterion.id}: ${criterion.evidence || criterion.notes || 'не пройдено'}`)
  .join('\n')

/**
 * @param {object} options - `executors`, `verifier`, `limits`, `logger`, `now`.
 * @returns {object} `run({ job, task, sessionId, signal, ... })`.
 */
export function createOrchestrator({ executors = [], verifier, limits = {}, logger, verify: defaultVerify, now = () => Date.now() } = {}) {
  const registry = createExecutorRegistry({ executors })

  async function run({
    job = {},
    task = '',
    sessionId,
    signal,
    executorId = 'dsh',
    budget: providedBudget,
    stopping = false,
    onStage = () => {},
    onUsage = () => {},
    verify: runVerify,
    repairTask,
    attemptId,
  } = {}) {
    const executor = registry.get(executorId)
    const verify = runVerify ?? defaultVerify
    const procedureLimits = job.procedure?.limits ?? {}
    const tokenLimit = minLimit(limits.tokenLimit, procedureLimits.taskTokenBudget)
    const maxSteps = minLimit(limits.maxSteps, procedureLimits.taskMaxSteps)
    const timeLimitMs = minLimit(limits.timeLimitMs, procedureLimits.taskTimeoutMs)
    const budget = providedBudget ?? createBudget({ tokenLimit, maxSteps, timeLimitMs, now })
    const startedAt = now()
    const stages = []
    const id = attemptId ?? `${job.id ?? 'task'}-1`

    const stage = (name, info = {}) => {
      stages.push({ stage: name, at: now(), ...info })
      try {
        onStage(name, info)
      } catch (error) {
        logger?.warn?.('orchestrator stage callback failed', { error })
      }
    }

    const parentAborted = () => Boolean(signal?.aborted)
    const abortedResult = (result = {}) => ({ ...result, ok: false, aborted: true })

    if (parentAborted()) {
      stage(STAGE.cancelled)
      return {
        result: abortedResult(),
        verification: undefined,
        budget: budget.snapshot(),
        attempts: 0,
        status: STAGE.cancelled,
        reason: 'cancelled',
        stages,
        startedAt,
      }
    }

    stage(STAGE.executing)
    let result
    try {
      result = await executor.execute({
        task,
        sessionId,
        signal,
        id,
        tokenBudget: budget.state.tokenLimit > 0 ? budget.remaining().tokens : 0,
        maxSteps: budget.state.maxSteps > 0 ? budget.remaining().steps : 0,
        timeoutMs: budget.state.timeLimitMs > 0 ? budget.remaining().timeMs : 0,
      })
    } catch (error) {
      logger?.warn?.('executor failed', { executor: executorId, error: error?.message ?? error })
      result = { ok: false, aborted: parentAborted(), error: String(error?.message ?? error), usage: EMPTY_USAGE() }
      budget.consume(result.usage, { unknown: true })
    }
    budget.consume(result?.usage ?? {}, { unknown: !result?.usage || result.usage.totalTokens === undefined })
    onUsage(result?.usage, { stage: STAGE.executing })
    if (parentAborted()) {
      result = abortedResult(result)
      stage(STAGE.cancelled)
      return { result, verification: undefined, budget: budget.snapshot(), attempts: 0, status: STAGE.cancelled, reason: 'cancelled', stages, startedAt }
    }

    let verification
    let attempts = 0
    let budgetBlocked = false
    const maxAttempts = Math.max(0, Number(verifier?.maxAttempts) || 0)
    const verifyResult = async () => {
      if (!verify) return undefined
      if (budget.exhausted()) {
        budgetBlocked = true
        return undefined
      }
      const left = budget.remaining().timeMs
      if (budget.state.timeLimitMs > 0 && left <= 0) {
        budgetBlocked = true
        return undefined
      }
      // Проверка не должна жить дольше остатка времени задачи.
      const verifySignal = budget.state.timeLimitMs > 0
        ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, left))])
        : signal
      stage(STAGE.verifying)
      try {
        const value = await verify({ result, signal: verifySignal, budget: budget.snapshot() })
        if (value?.usage) {
          budget.consume(value.usage, { unknown: value.usage.totalTokens === undefined })
          onUsage(value.usage, { stage: STAGE.verifying, unknown: value.usage.totalTokens === undefined })
        }
        if (budget.exhausted()) budgetBlocked = true
        return value
      } catch (error) {
        logger?.warn?.('verification failed', { error: error?.message ?? error })
        return { status: 'unavailable', criteria: [], limitations: [String(error?.message ?? error)], checkedAt: now() }
      }
    }

    verification = await verifyResult()
    if (parentAborted()) {
      result = abortedResult(result)
      stage(STAGE.cancelled)
      return { result, verification, budget: budget.snapshot(), attempts: 0, status: STAGE.cancelled, reason: 'cancelled', stages, startedAt }
    }
    while (verification && ['failed', 'partial'].includes(verification.status)
      && attempts < maxAttempts && result.ok && !parentAborted()) {
      if (budget.exhausted() || budget.state.unknownCost) {
        budgetBlocked = true
        stage(STAGE.failed, { reason: budget.state.unknownCost ? 'неизвестный расход' : 'бюджет исчерпан до исправления' })
        break
      }
      const feedback = failedFeedback(verification)
      if (!feedback) break
      attempts += 1
      stage(STAGE.repairing, { attempt: attempts, feedback })
      let repair
      try {
        repair = await executor.execute({
          task: typeof repairTask === 'function'
            ? repairTask({ result, verification, feedback, attempt: attempts })
            : `${job.text ?? task}\n\nПроверка результата нашла проблемы:\n${feedback}\nИсправь только их и отдай результат заново.`,
          sessionId: result.sessionId,
          signal,
          id: `${job.id ?? 'task'}-fix-${attempts}`,
          tokenBudget: budget.state.tokenLimit > 0 ? budget.remaining().tokens : 0,
          maxSteps: budget.state.maxSteps > 0 ? budget.remaining().steps : 0,
          timeoutMs: budget.state.timeLimitMs > 0 ? budget.remaining().timeMs : 0,
        })
      } catch (error) {
        logger?.warn?.('repair executor failed', { error: error?.message ?? error })
        budget.consume(EMPTY_USAGE(), { unknown: true })
        onUsage(EMPTY_USAGE(), { stage: STAGE.repairing, unknown: true })
        break
      }
      budget.consume(repair?.usage ?? {}, { unknown: !repair?.usage || repair.usage.totalTokens === undefined })
      onUsage(repair?.usage, { stage: STAGE.repairing })
      if (parentAborted()) {
        result = abortedResult(repair)
        stage(STAGE.cancelled)
        return { result, verification, budget: budget.snapshot(), attempts, status: STAGE.cancelled, reason: 'cancelled', stages, startedAt }
      }
      if (!repair?.ok) {
        result = repair
        break
      }
      result = repair
      if (parentAborted()) {
        result = abortedResult(result)
        stage(STAGE.cancelled)
        return { result, verification, budget: budget.snapshot(), attempts, status: STAGE.cancelled, reason: 'cancelled', stages, startedAt }
      }
      verification = await verifyResult()
      if (parentAborted()) {
        result = abortedResult(result)
        stage(STAGE.cancelled)
        return { result, verification, budget: budget.snapshot(), attempts, status: STAGE.cancelled, reason: 'cancelled', stages, startedAt }
      }
      if (verification) verification.attempts = attempts + 1
    }

    if (parentAborted()) {
      result = abortedResult(result)
      stage(STAGE.cancelled)
      return { result, verification, budget: budget.snapshot(), attempts, status: STAGE.cancelled, reason: 'cancelled', stages, startedAt }
    }
    let outcome = classifyOutcome({ result, verification, stopping })
    if (budget.exhausted() && outcome.status === STAGE.done) {
      outcome = { status: STAGE.partial, reason: budget.state.unknownCost ? 'unknown_budget' : 'budget' }
    }
    if (budgetBlocked && !["cancelled", "interrupted", "failed"].includes(outcome.status)) {
      outcome = { status: STAGE.partial, reason: budget.state.unknownCost ? "unknown_budget" : "budget" }
    }
    stage(outcome.status, outcome.reason ? { reason: outcome.reason } : {})
    return {
      result,
      verification,
      budget: budget.snapshot(),
      attempts,
      status: outcome.status,
      reason: outcome.reason,
      stages,
      startedAt,
    }
  }

  return {
    run,
    registry,
    executorIds: () => registry.ids(),
  }
}
