/**
 * Адаптер существующего DSH-раннера к контракту исполнителя (PLA-19).
 *
 * Раннер продолжает отвечать за процесс DSH, cgroup и разбор событий; адаптер
 * нормализует вызов и не добавляет второй цикл исполнения.
 */
export function createDshExecutor({ runner, limits = {}, modelProfile, tools = [] } = {}) {
  if (!runner?.run) throw new Error('DSH-адаптеру нужен runner.run')
  return {
    id: 'dsh',
    capabilities: ['code', 'files', 'long-task', 'verification-repair'],
    limits: { ...limits },
    modelProfile,
    tools: [...tools],
    status: 'ready',
    async execute({ task, sessionId, signal, id, tokenBudget, maxSteps, timeoutMs, workspaceDir } = {}) {
      const result = await runner.run({ task, sessionId, signal, id, tokenBudget, maxSteps, timeoutMs, workspaceDir })
      return {
        ...result,
        usage: result?.usage ?? { totalTokens: undefined, steps: undefined, unknown: true },
      }
    },
  }
}
