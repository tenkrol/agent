/**
 * Общий бюджет попытки: токены, шаги и время.
 *
 * Лимит процедуры может только уменьшать глобальный потолок. Проверка и
 * исправление расходуют остаток, а не получают новый полный лимит. Если
 * провайдер не сообщил расход, это «неизвестно», а не ноль: такой исход не
 * открывает бесконечные бесплатные повторы.
 */
const positive = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

export function createBudget({ tokenLimit = 0, maxSteps = 0, timeLimitMs = 0, now = () => Date.now() } = {}) {
  const state = {
    tokenLimit: positive(tokenLimit),
    maxSteps: positive(maxSteps),
    timeLimitMs: positive(timeLimitMs),
    tokens: 0,
    steps: 0,
    unknownCost: false,
    startedAt: now(),
  }
  const remaining = () => ({
    tokens: state.tokenLimit > 0 ? Math.max(0, state.tokenLimit - state.tokens) : 0,
    steps: state.maxSteps > 0 ? Math.max(0, state.maxSteps - state.steps) : 0,
    timeMs: state.timeLimitMs > 0 ? Math.max(0, state.timeLimitMs - (now() - state.startedAt)) : 0,
  })
  const exhausted = () => {
    const left = remaining()
    return (state.tokenLimit > 0 && left.tokens <= 0)
      || (state.maxSteps > 0 && left.steps <= 0)
      || (state.timeLimitMs > 0 && left.timeMs <= 0)
  }
  return {
    state,
    remaining,
    exhausted,
    /** Учесть расход стадии; неизвестный расход отмечается явно. */
    consume(usage = {}, { unknown = false } = {}) {
      // total_tokens может отсутствовать, но известные части — валидная сумма.
      let total = Number(usage.totalTokens)
      if (!Number.isFinite(total) || total < 0) {
        const parts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
          .map(Number)
          .filter((value) => Number.isFinite(value) && value > 0)
        total = parts.length > 0 ? parts.reduce((sum, value) => sum + value, 0) : NaN
      }
      if (Number.isFinite(total)) state.tokens += total
      else state.unknownCost = true
      const steps = Number(usage.steps)
      if (Number.isFinite(steps) && steps >= 0) state.steps += steps
      if (unknown) state.unknownCost = true
      return state
    },
    snapshot() {
      return { ...state, remaining: remaining(), exhausted: exhausted() }
    },
  }
}

/** Меньший из двух лимитов; 0 означает «без отдельного лимита». */
export const minLimit = (global, local) => {
  const a = positive(global)
  const b = positive(local)
  if (a === 0) return b
  if (b === 0) return a
  return Math.min(a, b)
}
