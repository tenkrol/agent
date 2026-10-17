/**
 * Воркер доставки: отдельно от выполнения задачи.
 *
 * Доставка ассистенту идёт событием с постоянным `eventId` и подтверждением
 * обработки; личный чат агента — текстом. Оба канала учитываются в журнале
 * доставок, повторяются с ограниченной частотой и не перезапускают задачу.
 * Ошибка ассистента в итоге уведомляет владельца в личном чате.
 */
import { postAgentEvent } from '../integrations/outbox.mjs'

const DEFAULTS = {
  retryMs: [60_000, 300_000, 900_000, 3_600_000, 21_600_000],
  maxAttempts: 8,
  tickMs: 30_000,
}

/** Задержка перед следующей попыткой. */
function retryDelay(attempts, schedule) {
  const list = Array.isArray(schedule) && schedule.length > 0 ? schedule : DEFAULTS.retryMs
  return list[Math.min(Math.max(0, attempts - 1), list.length - 1)]
}

export class DeliveryWorker {
  /**
   * @param {object} options - `store`, `platform`, `outbox` ({url, token}),
   *   `logger`, `actions`, `now`, `onFailed`, `retryMs`, `maxAttempts`, `tickMs`.
   */
  constructor({ store, platform, outbox, logger, actions, now = () => Date.now(), onFailed, retryMs, maxAttempts, tickMs, fetchImpl } = {}) {
    this.store = store
    this.platform = platform
    this.outbox = outbox ?? {}
    this.logger = logger
    this.actions = actions
    this.now = now
    this.onFailed = onFailed
    this.retryMs = Array.isArray(retryMs) && retryMs.length > 0 ? retryMs : DEFAULTS.retryMs
    this.maxAttempts = Number(maxAttempts) > 0 ? Number(maxAttempts) : DEFAULTS.maxAttempts
    this.tickMs = Number(tickMs) > 0 ? Number(tickMs) : DEFAULTS.tickMs
    this.fetchImpl = fetchImpl
    this.timer = undefined
    this.ticking = false
  }

  /** Start the retry timer (unref: it must not keep the process alive). */
  start() {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, this.tickMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Process everything that is due. */
  async tick() {
    if (this.ticking) return 0
    this.ticking = true
    try {
      const due = this.store.due(this.now())
      for (const record of due) await this.attempt(record)
      return due.length
    } finally {
      this.ticking = false
    }
  }

  /**
   * Put one event into the journal and try it immediately.
   *
   * @returns {Promise<object>} the record after the attempt.
   */
  async enqueue(event, { channel = 'assistant' } = {}) {
    const { record } = await this.store.create(event, { channel })
    if (record.state !== 'pending') return record
    return this.attempt(record)
  }

  /** Учесть уже выполненную личную отправку (сообщение ушло синхронно). */
  async trackPersonal({ taskId, text, chatId, receipt, eventId } = {}) {
    const id = eventId ?? `${taskId}:personal:${Date.now()}`
    const { record } = await this.store.create({
      eventId: id,
      taskId,
      type: 'result',
      createdAt: Date.now(),
      chatId,
      text,
    }, { channel: 'personal' })
    return this.store.settle(record.eventId, { state: 'acked', outcome: 'acked', processed: true, receipt })
  }

  /** One attempt for one record. */
  async attempt(record) {
    const action = await this.#beginAction(record)
    try {
      if (record.channel === 'personal') return await this.#attemptPersonal(record, action)
      return await this.#attemptAssistant(record, action)
    } catch (error) {
      this.logger?.error('delivery attempt failed', { eventId: record.eventId, error })
      return this.#retryLater(record, action, String(error?.message ?? error))
    }
  }

  async #attemptAssistant(record, action) {
    await this.store.sending(record.eventId)
    const event = { ...record.payload, attempt: (record.attempts ?? 0) + 1 }
    const result = await postAgentEvent({ url: this.outbox.url, token: this.outbox.token, event, fetchImpl: this.fetchImpl })
    if (!result.ok) {
      const terminal = Number(result.status) >= 400 && Number(result.status) < 500
      await this.#confirmAction(action, result.status)
      if (terminal) return this.#fail(record, action, result.error ?? `HTTP ${result.status}`)
      return this.#retryLater(record, action, result.error ?? `HTTP ${result.status}`)
    }
    if (result.processed) {
      const updated = await this.store.settle(record.eventId, {
        state: 'acked',
        outcome: 'acked',
        processed: true,
        duplicate: result.duplicate,
        status: result.status,
      })
      await this.#confirmAction(action, result.status)
      this.logger?.info('delivery acked', { eventId: record.eventId })
      return updated
    }
    // Старый приёмник: 2xx, но подтверждения нет. Повторять нельзя — сообщение уже ушло.
    const updated = await this.store.settle(record.eventId, {
      state: 'sent',
      outcome: 'sent',
      processed: false,
      status: result.status,
    })
    await this.#confirmAction(action, result.status)
    this.logger?.info('delivery sent without ack (legacy receiver)', { eventId: record.eventId })
    return updated
  }

  async #attemptPersonal(record, action) {
    await this.store.sending(record.eventId)
    const text = String(record.payload?.text ?? '')
    const sent = await this.platform.sendText({ chatId: record.payload?.chatId, markdown: text })
    const updated = await this.store.settle(record.eventId, {
      state: 'acked',
      outcome: 'acked',
      processed: true,
      receipt: sent?.messageId,
    })
    await this.#confirmAction(action, sent?.messageId)
    return updated
  }

  async #retryLater(record, action, error) {
    const attempts = (record.attempts ?? 0) + 1
    await this.#unknownAction(action, error)
    if (attempts >= this.maxAttempts) return this.#fail(record, action, error)
    const nextAttemptAt = this.now() + retryDelay(attempts, this.retryMs)
    return this.store.settle(record.eventId, {
      state: 'pending',
      outcome: 'unknown',
      error,
      nextAttemptAt,
    })
  }

  async #fail(record, action, error) {
    const updated = await this.store.settle(record.eventId, {
      state: 'failed',
      outcome: 'failed',
      error,
    })
    this.logger?.warn('delivery failed', { eventId: record.eventId, taskId: record.taskId, error })
    await this.#unknownAction(action, error)
    if (record.channel === 'assistant' && record.type !== 'memory_proposal') {
      await this.onFailed?.(record, error)
    }
    return updated
  }

  async #beginAction(record) {
    if (!this.actions) return undefined
    try {
      return await this.actions.begin({ taskId: record.taskId, kind: `delivery:${record.channel}`, target: record.eventId })
    } catch {
      return undefined
    }
  }

  async #confirmAction(action, receipt) {
    if (!action || !this.actions) return
    try {
      await this.actions.confirm(action.id, { receipt })
    } catch {
      // Журнал действий не должен ломать доставку.
    }
  }

  async #unknownAction(action, reason) {
    if (!action || !this.actions) return
    try {
      await this.actions.unknown(action.id, { reason })
    } catch {
      // Журнал действий не должен ломать доставку.
    }
  }
}
