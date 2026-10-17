/**
 * Владелец очереди, восстановления, awaiting и терминальных переходов (PLA-22).
 *
 * Работает поверх существующего JSONL-журнала и state.json; формат данных не
 * меняется. AgentBot делегирует сюда очередь и завершение, а сам остаётся
 * адаптером входа и доставки.
 */
export function createTaskLifecycle({ journal, stateStore, now = () => Date.now() } = {}) {
  const state = { queue: [], running: undefined }

  return {
    get queue() {
      return state.queue
    },
    set queue(value) {
      state.queue = value
    },
    get running() {
      return state.running
    },
    set running(value) {
      state.running = value
    },
    get length() {
      return state.queue.length
    },

    enqueue(job) {
      state.queue.push(job)
      return state.queue.length
    },
    shift() {
      return state.queue.shift()
    },

    /** Снять задачи из очереди и пометить их отменёнными в журнале. */
    async clearQueue(reason) {
      const queued = [...state.queue]
      state.queue = []
      for (const job of queued) {
        await this.transition(job.id, 'cancelled', { reason: 'cancelled', patch: { error: reason } }).catch(() => {})
      }
      return queued.length
    },

    /** Единый цикл очереди: ошибку обрабатывает адаптер входа. */
    async drain({ runTask, onError, isStopping = () => false } = {}) {
      while (state.queue.length > 0 && !isStopping()) {
        const job = state.queue.shift()
        try {
          await runTask(job)
        } catch (error) {
          if (onError) await onError(job, error)
          else throw error
        }
      }
    },

    /** Восстановить очередь и awaiting из журнала; interrupted не запускаются. */
    async recover({ actions, recordToJob, snapshot, workspaceDir } = {}) {
      const interrupted = journal ? await journal.recover() : []
      await actions?.recover?.()
      const pending = journal ? journal.pending() : []
      state.queue = pending.map((record) => recordToJob(record))
      if (journal) {
        for (const record of interrupted) {
          try {
            const files = await snapshot(workspaceDir)
            const since = Number(record.startedAt ?? record.createdAt ?? 0)
            const partialFiles = [...files.entries()]
              .filter(([, meta]) => (meta.mtimeMs ?? 0) >= since)
              .map(([relPath]) => relPath)
              .slice(0, 20)
            await journal.update(record.id, { partialFiles })
          } catch {
            // Снимок файлов — диагностика, не причина не поднимать очередь.
          }
        }
      }
      for (const record of journal?.awaiting() ?? []) {
        const key = `await:${record.chatId}`
        if (stateStore.get(key)) continue
        stateStore.set(key, {
          taskId: record.id,
          askedAt: record.askedAt ?? record.updatedAt ?? now(),
          kind: Array.isArray(record.variants) && record.variants.length > 0 ? 'variant' : 'question',
          question: record.question,
          variants: record.variants,
          sessionId: record.sessionId,
          brief: record.brief,
        })
      }
      await stateStore?.flush?.()
      return { pending, interrupted }
    },

    // ─── awaiting ────────────────────────────────────────────────────────
    awaitingFor(chatId) {
      return stateStore.get(`await:${chatId}`)
    },
    async setAwaiting(chatId, payload) {
      stateStore.set(`await:${chatId}`, { askedAt: now(), ...payload })
      await stateStore.flush()
    },
    async clearAwaiting(chatId) {
      stateStore.delete(`await:${chatId}`)
      await stateStore.flush()
    },

    // ─── терминальные переходы ───────────────────────────────────────────
    close(id, patch = {}) {
      return journal?.close(id, patch)
    },
    update(id, patch = {}) {
      return journal?.update(id, patch)
    },
    transition(id, to, options = {}) {
      return journal?.transition(id, to, options)
    },
    requeue(id, options = {}) {
      return journal?.requeue(id, options)
    },
  }
}
