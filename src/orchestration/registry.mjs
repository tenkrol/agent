/**
 * Реестр исполнителей: детерминированный выбор по id.
 *
 * Неизвестный явно указанный исполнитель даёт понятную ошибку, а не тихую
 * подмену. LLM-планирование на этом этапе не нужно.
 */
export function createExecutorRegistry({ executors = [] } = {}) {
  const byId = new Map()
  for (const executor of executors) {
    if (!executor?.id) throw new Error('исполнитель без id')
    if (byId.has(executor.id)) throw new Error(`исполнитель ${executor.id} уже зарегистрирован`)
    byId.set(executor.id, executor)
  }
  return {
    ids: () => [...byId.keys()],
    capabilities: (id) => byId.get(id)?.capabilities ?? [],
    describe() {
      return [...byId.values()].map((executor) => ({
        id: executor.id,
        capabilities: [...(executor.capabilities ?? [])],
        limits: { ...(executor.limits ?? {}) },
        modelProfile: executor.modelProfile,
        profileStatus: executor.profileStatus ?? (executor.modelProfile ? 'unsupported' : undefined),
        tools: [...(executor.tools ?? [])],
        status: executor.status ?? 'ready',
      }))
    },
    has: (id) => byId.has(id),
    get(id) {
      const executor = byId.get(id)
      if (!executor) throw new Error(`неизвестный исполнитель: ${id}`)
      return executor
    },
  }
}
