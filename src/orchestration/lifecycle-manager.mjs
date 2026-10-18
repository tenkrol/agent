/**
 * Владелец очереди, восстановления, awaiting и терминальных переходов (PLA-22).
 *
 * Работает поверх существующего JSONL-журнала и state.json; формат данных не
 * меняется. AgentBot делегирует сюда очередь и завершение, а сам остаётся
 * адаптером входа и доставки.
 */
export function createTaskLifecycle({ journal, stateStore, queueStore, now = () => Date.now() } = {}) {
  // Активных попыток может быть несколько (параллельные workers); каждая со своим id.
  const state = { queue: [], runs: new Map() }

  return {
    get queue() {
      return state.queue
    },
    set queue(value) {
      state.queue = value
    },
    get running() {
      return [...state.runs.values()][0]
    },
    get length() {
      return state.queue.length
    },

    /** Только чтение для /status и тестов; менять очередь снаружи нельзя. */
    snapshot() {
      const runs = [...state.runs.values()]
      return {
        length: state.queue.length,
        queue: [...state.queue],
        running: runs[0] ? { ...runs[0] } : undefined,
        runningCount: runs.length,
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
      if (state.runs.has(id)) throw new Error(`уже выполняется задача ${id}`)
      const running = { id, chatId, controller, startedAt, attemptId, steps: 0, tools: 0, stage }
      state.runs.set(id, running)
      return running
    },
    finish(id) {
      if (id === undefined) state.runs.clear()
      else state.runs.delete(id)
    },
    /** Занять слот планированием для этой задачи; вернуть, были ли мы владельцем. */
    beginIfIdle(payload = {}) {
      if (payload.id !== undefined && state.runs.has(payload.id)) return false
      const running = { steps: 0, tools: 0, stage: 'planning', ...payload }
      state.runs.set(payload.id ?? `plan-${state.runs.size + 1}`, running)
      return true
    },
    updateRunning(patch = {}, id) {
      const running = id === undefined ? [...state.runs.values()][0] : state.runs.get(id)
      if (running) Object.assign(running, patch)
    },
    cancelRunning(id) {
      const targets = id === undefined ? [...state.runs.values()] : [state.runs.get(id)].filter(Boolean)
      for (const running of targets) running.controller?.abort()
      return targets[0]
    },

    /** Повтор/продолжение: requeue в журнале и постановка в очередь. */
    async retry({ taskId, job, reason, patch } = {}) {
      if (queueStore) {
        const result = queueStore.requeue({ taskId, payload: job, requestKey: job.requestKey, now: now() })
        if (!result.ok) return { ok: false, ...result }
      } else {
        state.queue.push(job)
      }
      if (!state.queue.some((item) => item.id === job.id)) state.queue.push(job)
      if (journal) await journal.requeue(taskId, { reason, patch })
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
      const queued = queueStore ? queueStore.listPending().filter((row) => row.status === 'queued') : [...state.queue]
      queueStore?.cancelAll({ now: now() })
      state.queue = []
      for (const item of queued) {
        await this.transition(item.id, 'cancelled', { reason: 'cancelled', patch: { error: reason } }).catch(() => {})
      }
      return queued.length
    },

    /**
     * Единый цикл очереди: ошибку обрабатывает адаптер входа.
     *
     * С SQLite каждый worker захватывает задачу через аренду; при workers>1
     * циклы идут параллельно, а повторный захват той же задачи невозможен.
     */
    async drain({ runTask, onError, isStopping = () => false, workers = 1, allowParallel = false, owner = `worker-${process.pid}`, leaseTtlMs = 60_000 } = {}) {
      if (Number(workers) > 1 && !allowParallel) {
        throw new Error('QUEUE_WORKERS>1 требует изолированного workspace')
      }
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const waitForLease = async () => {
        const at = queueStore?.nextLeaseAt?.()
        if (at === undefined) return false
        const wait = Math.max(0, at - now() + 5)
        await sleep(Math.min(wait, 1000))
        return true
      }
      while (!isStopping()) {
        let job
        let lease
        if (queueStore) {
          lease = queueStore.claim({ owner, ttlMs: leaseTtlMs, now: now() })
          if (!lease) {
            if (await waitForLease()) continue
            break
          }
          job = lease.payload
          state.queue = state.queue.filter((item) => item.id !== lease.id)
        } else {
          if (state.queue.length === 0) break
          job = state.queue.shift()
        }
        const leaseSignal = new AbortController()
        let accepted = false
        const owns = () => !lease || queueStore.owns({ taskId: lease.id, generation: lease.generation, owner, now: now() })
        const accept = (data = {}) => {
          if (!lease || !queueStore) return { ok: false, unsupported: true }
          const result = queueStore.accept({
            taskId: lease.id,
            generation: lease.generation,
            owner,
            status: data.status,
            payload: data.payload,
            outbox: data.outbox,
            now: now(),
          })
          if (result.ok) accepted = true
          return result
        }
        const heartbeat = lease
          ? setInterval(() => {
            const renewed = queueStore.heartbeat({ taskId: lease.id, generation: lease.generation, owner, ttlMs: leaseTtlMs, now: now() })
            if (!renewed) leaseSignal.abort()
          }, Math.max(500, Math.floor(leaseTtlMs / 3)))
          : undefined
        heartbeat?.unref?.()
        try {
          await runTask(job, { leaseSignal: leaseSignal.signal, owns, ...(queueStore && lease ? { accept } : {}) })
          if (lease) {
            if (accepted) continue
            if (!owns()) {
              // Старая попытка потеряла аренду: не пишем терминал и не доставляем.
              continue
            }
            const status = journal?.get?.(lease.id)?.status
            if (status === 'awaiting_owner' || status === 'queued') {
              queueStore.setStatus({ taskId: lease.id, generation: lease.generation, owner, status, now: now() })
            } else {
              queueStore.complete({ taskId: lease.id, generation: lease.generation, owner, status: status ?? 'done', now: now() })
            }
          }
        } catch (error) {
          const stillOwns = owns()
          if (lease && stillOwns) queueStore.complete({ taskId: lease.id, generation: lease.generation, owner, status: 'failed', now: now() })
          if (stillOwns) {
            if (onError) await onError(job, error)
            else throw error
          }
        } finally {
          clearInterval(heartbeat)
          leaseSignal.abort()
        }
      }
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
        // Задачи, пережившие падение в running, тоже должны попасть в память:
        // drain сам дождётся истечения их аренды. Журнал после recover() уже
        // помечает их interrupted — возвращаем в queued до повторного запуска.
        for (const row of queueStore.listPending()) {
          if (row.status === 'running' && typeof journal?.requeue === 'function') {
            await journal.requeue(row.id, {
              reason: 'восстановление аренды',
              patch: { resumedAt: now() },
            }).catch(() => {})
          }
          if (!state.queue.some((job) => job.id === row.id)) state.queue.push(row.payload)
        }
      }
      // Сверка после сбоя между SQLite и JSONL: если очередь уже зафиксировала
      // терминальный результат, журнал нельзя оставлять running/verifying.
      if (queueStore && typeof journal?.recent === 'function') {
        const terminal = new Set(['done', 'partial', 'failed', 'cancelled'])
        for (const record of journal.recent(1000)) {
          if (terminal.has(record.status)) continue
          const row = queueStore.get(record.id)
          if (row && terminal.has(row.status)) {
            await journal.close(record.id, { status: row.status, reason: 'сверка с SQLite-очередью' }).catch(() => {})
          }
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
