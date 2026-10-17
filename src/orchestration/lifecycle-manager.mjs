/**
 * Владелец очереди, восстановления, awaiting и терминальных переходов (PLA-22).
 *
 * Работает поверх существующего JSONL-журнала и state.json; формат данных не
 * меняется. AgentBot делегирует сюда очередь и завершение, а сам остаётся
 * адаптером входа и доставки.
 */
export function createTaskLifecycle({ journal, stateStore, queueStore, now = () => Date.now() } = {}) {
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

    /** Только чтение для /status и тестов; менять очередь снаружи нельзя. */
    snapshot() {
      return {
        length: state.queue.length,
        queue: [...state.queue],
        running: state.running ? { ...state.running } : undefined,
      }
    },

    /** Поставить задачу: при SQLite — транзакционно, память остаётся для статуса. */
    enqueue(job) {
      state.queue.push(job)
      queueStore?.enqueue({ id: job.id, requestKey: job.requestKey, payload: job })
      return state.queue.length
    },

    /** Начать попытку: единственный владелец активного контроллера. */
    begin({ id, chatId, controller, startedAt, attemptId, stage = 'executing' } = {}) {
      if (state.running) throw new Error(`уже выполняется задача ${state.running.id}`)
      state.running = { id, chatId, controller, startedAt, attemptId, steps: 0, tools: 0, stage }
      return state.running
    },
    finish() {
      state.running = undefined
    },
    /** Занять слот планированием, если он свободен; вернуть, были ли мы владельцем. */
    beginIfIdle(payload = {}) {
      if (state.running) return false
      state.running = { steps: 0, tools: 0, stage: 'planning', ...payload }
      return true
    },
    updateRunning(patch = {}) {
      if (state.running) Object.assign(state.running, patch)
    },
    cancelRunning() {
      const running = state.running
      running?.controller?.abort()
      return running
    },

    /** Повтор/продолжение: requeue в журнале и постановка в очередь. */
    async retry({ taskId, job, reason, patch } = {}) {
      if (journal) await journal.requeue(taskId, { reason, patch })
      state.queue.push(job)
      queueStore?.enqueue({ id: job.id, requestKey: job.requestKey, payload: job })
      return state.queue.length
    },

    /** Убрать задачу из очереди по id, не трогая журнал. */
    cancelQueued(id) {
      const before = state.queue.length
      state.queue = state.queue.filter((job) => job.id !== id)
      queueStore?.cancel({ taskId: id })
      return before - state.queue.length
    },

    /** Переход в выполнение — решение о статусе принимает lifecycle. */
    beginTask(taskId, options = {}) {
      return journal?.transition(taskId, 'running', options)
    },
    beginVerification(taskId, options = {}) {
      return journal?.transition(taskId, 'verifying', options)
    },

    /** Вопрос/план: журнал и awaiting пишутся одной операцией. */
    async awaitAnswer({ taskId, chatId, patch = {}, awaiting = {} } = {}) {
      if (journal) await journal.update(taskId, { status: 'awaiting_owner', ...patch })
      await this.setAwaiting(chatId, { taskId, ...awaiting })
    },

    /** Завершение: единственный выход терминального статуса. */
    async finishTask(taskId, patch = {}) {
      return journal?.close(taskId, patch)
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

    /**
     * Единый цикл очереди: ошибку обрабатывает адаптер входа.
     *
     * С SQLite каждый worker захватывает задачу через аренду; при workers>1
     * циклы идут параллельно, а повторный захват той же задачи невозможен.
     */
    async drain({ runTask, onError, isStopping = () => false, workers = 1, owner = `worker-${process.pid}`, leaseTtlMs = 60_000 } = {}) {
      const count = Math.max(1, Number(workers) || 1)
      const one = async (workerId) => {
        while (!isStopping()) {
          let job
          let lease
          if (queueStore) {
            lease = queueStore.claim({ owner: workerId, ttlMs: leaseTtlMs, now: now() })
            if (!lease) break
            job = lease.payload
            state.queue = state.queue.filter((item) => item.id !== lease.id)
          } else {
            if (state.queue.length === 0) break
            job = state.queue.shift()
          }
          const heartbeat = lease
            ? setInterval(() => queueStore.heartbeat({ taskId: lease.id, generation: lease.generation, owner: workerId, ttlMs: leaseTtlMs, now: now() }), Math.max(1000, Math.floor(leaseTtlMs / 3)))
            : undefined
          heartbeat?.unref?.()
          try {
            await runTask(job)
            if (lease) {
              const status = journal?.get?.(lease.id)?.status
              if (status === 'awaiting_owner' || status === 'queued') {
                queueStore.setStatus({ taskId: lease.id, generation: lease.generation, status, now: now() })
              } else {
                queueStore.complete({ taskId: lease.id, generation: lease.generation, status: status ?? 'done', now: now() })
              }
            }
          } catch (error) {
            if (lease) queueStore.complete({ taskId: lease.id, generation: lease.generation, status: 'failed', now: now() })
            if (onError) await onError(job, error)
            else throw error
          } finally {
            clearInterval(heartbeat)
          }
        }
      }
      await Promise.all(Array.from({ length: count }, (_, index) => one(`${owner}-${index + 1}`)))
    },

    /** Восстановить очередь и awaiting из журнала; interrupted не запускаются. */
    async recover({ actions, recordToJob, snapshot, workspaceDir } = {}) {
      const interrupted = journal ? await journal.recover() : []
      await actions?.recover?.()
      const pending = journal ? journal.pending() : []
      state.queue = pending.map((record) => recordToJob(record))
      if (queueStore) {
        queueStore.recoverExpired({ now: now() })
        for (const job of state.queue) {
          queueStore.enqueue({ id: job.id, requestKey: job.requestKey, payload: job })
        }
      }
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
