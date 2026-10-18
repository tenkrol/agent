/**
 * Адаптер существующего DSH-раннера к контракту исполнителя (PLA-19).
 *
 * Раннер продолжает отвечать за процесс DSH, cgroup и разбор событий; адаптер
 * нормализует вызов и не добавляет второй цикл исполнения.
 */
export function createDshExecutor({ runner, id = 'dsh', capabilities = ['code', 'files', 'long-task', 'verification-repair'], taskPrefix = '', limits = {}, modelProfile, tools = [] } = {}) {
  if (!runner?.run) throw new Error('DSH-адаптеру нужен runner.run')
  return {
    id,
    capabilities: [...capabilities],
    limits: { ...limits },
    modelProfile,
    tools: [...tools],
    status: 'ready',
    async execute({ task, sessionId, signal, id: attemptId, tokenBudget, maxSteps, timeoutMs, workspaceDir } = {}) {
      const prefix = typeof taskPrefix === 'function' ? taskPrefix({ task, workspaceDir }) : taskPrefix
      const result = await runner.run({ task: `${prefix}${task}`, sessionId, signal, id: attemptId, tokenBudget, maxSteps, timeoutMs, workspaceDir })
      return {
        ...result,
        usage: result?.usage ?? { totalTokens: undefined, steps: undefined, unknown: true },
      }
    },
  }
}
