/**
 * Адаптер существующего DSH-раннера к контракту исполнителя (PLA-19).
 *
 * Раннер продолжает отвечать за процесс DSH, cgroup и разбор событий; адаптер
 * нормализует вызов и не добавляет второй цикл исполнения.
 */
export function createDshExecutor({ runner } = {}) {
  if (!runner?.run) throw new Error('DSH-адаптеру нужен runner.run')
  return {
    id: 'dsh',
    capabilities: ['code', 'files', 'long-task', 'verification-repair'],
    async execute({ task, sessionId, signal, id, tokenBudget, maxSteps, timeoutMs } = {}) {
      const result = await runner.run({ task, sessionId, signal, id, tokenBudget, maxSteps, timeoutMs })
      return {
        ...result,
        usage: result?.usage ?? { totalTokens: undefined, steps: undefined, unknown: true },
      }
    },
  }
}
