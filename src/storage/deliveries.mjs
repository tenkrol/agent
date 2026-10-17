/**
 * Журнал доставки: отдельно от выполнения задачи.
 *
 * Одно событие — одна запись: канал (`assistant` или `personal`), состояние,
 * число и время попыток, подтверждение обработки. Append-only JSONL, последняя
 * строка для `eventId` побеждает. После сбоя запись в `sending` не считается
 * зависшей: исход неизвестен, повтор идёт по правилам доставки.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const VERSION = 1

export const DELIVERY = {
  pending: 'pending',
  sending: 'sending',
  sent: 'sent',
  acked: 'acked',
  failed: 'failed',
}

/** Add one durable line and sync it. */
async function appendDurable(file, line) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const handle = await fs.open(file, 'a')
  try {
    await handle.write(line)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export class DeliveryStore {
  /**
   * @param {object} options - `file`, `logger`, `maxEntries`.
   */
  constructor({ file, logger, maxEntries = 5000 } = {}) {
    this.file = file
    this.logger = logger
    this.maxEntries = maxEntries
    this.records = new Map()
    this.writing = Promise.resolve()
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        try {
          const parsed = JSON.parse(line)
          if (parsed?.version !== VERSION || typeof parsed.eventId !== 'string') throw new Error('unexpected record')
          this.records.set(parsed.eventId, parsed)
        } catch {
          // Неполная строка после сбоя пропускается.
        }
      }
      this.compactMemory()
      this.logger?.info('delivery journal loaded', { events: this.records.size })
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn('delivery journal unreadable, starting empty', { error })
    }
    return this
  }

  compactMemory() {
    if (this.records.size <= this.maxEntries) return
    const ordered = [...this.records.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    for (const record of ordered.slice(0, this.records.size - this.maxEntries)) this.records.delete(record.eventId)
  }

  /** Create a delivery record unless the event is already known. */
  async create(event, { channel = 'assistant' } = {}) {
    const existing = this.records.get(String(event.eventId))
    if (existing) return { record: existing, duplicate: true }
    const now = Date.now()
    const record = {
      version: VERSION,
      eventId: String(event.eventId),
      taskId: event.taskId === undefined ? undefined : String(event.taskId),
      type: String(event.type ?? 'result'),
      channel,
      route: event.route,
      payload: event,
      state: DELIVERY.pending,
      outcome: undefined,
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    }
    await this.save(record, { durable: true })
    return { record, duplicate: false }
  }

  /** One record. */
  get(eventId) {
    return this.records.get(String(eventId))
  }

  /** Records of one task, oldest first. */
  ofTask(taskId) {
    const id = String(taskId)
    return [...this.records.values()]
      .filter((record) => String(record.taskId ?? '') === id)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  }

  /** Deliveries that need an attempt now. */
  due(now = Date.now()) {
    return [...this.records.values()].filter((record) => {
      if (record.state === DELIVERY.pending) return (record.nextAttemptAt ?? 0) <= now
      // После рестарта или неизвестного исхода повторяем с тем же eventId.
      if (record.state === DELIVERY.sent && record.outcome === 'unknown') return (record.nextAttemptAt ?? 0) <= now
      return false
    })
  }

  /** Mark an attempt as started (durably, before the network call). */
  async sending(eventId) {
    return this.#patch(eventId, { state: DELIVERY.sending, updatedAt: Date.now() })
  }

  /** Record the result of an attempt. */
  async settle(eventId, { state, outcome, processed, duplicate, error, status, receipt, nextAttemptAt } = {}) {
    const existing = this.records.get(String(eventId))
    if (!existing) return undefined
    return this.#patch(eventId, {
      state,
      outcome,
      processed: processed === undefined ? existing.processed : Boolean(processed),
      duplicate: duplicate === undefined ? existing.duplicate : Boolean(duplicate),
      error,
      status,
      receipt,
      attempts: (existing.attempts ?? 0) + 1,
      nextAttemptAt,
      sentAt: state === DELIVERY.sent || state === DELIVERY.acked ? Date.now() : existing.sentAt,
      ackedAt: state === DELIVERY.acked ? Date.now() : existing.ackedAt,
    })
  }

  /** Failed delivery can be put back into the queue manually. */
  async retry(eventId) {
    return this.#patch(eventId, {
      state: DELIVERY.pending,
      outcome: undefined,
      error: undefined,
      nextAttemptAt: Date.now(),
    })
  }

  /**
   * Startup recovery: `sending` never stays stuck.
   *
   * @returns {Promise<number>} how many records were recovered.
   */
  async recoverSending() {
    let count = 0
    for (const record of [...this.records.values()]) {
      if (record.state !== DELIVERY.sending) continue
      await this.#patch(record.eventId, {
        state: DELIVERY.sent,
        outcome: 'unknown',
        nextAttemptAt: Date.now(),
        lastError: 'перезапуск во время отправки',
      })
      count += 1
    }
    return count
  }

  async #patch(eventId, patch) {
    const existing = this.records.get(String(eventId))
    if (!existing) return undefined
    const record = { ...existing, ...patch, version: VERSION, updatedAt: Date.now() }
    await this.save(record)
    return record
  }

  save(record, { durable = true } = {}) {
    this.records.set(record.eventId, record)
    this.compactMemory()
    const line = `${JSON.stringify(record)}\n`
    const write = this.writing.then(async () => {
      if (durable) await appendDurable(this.file, line)
      else {
        await fs.mkdir(path.dirname(this.file), { recursive: true })
        await fs.appendFile(this.file, line, 'utf8')
      }
    })
    this.writing = write.catch((error) => {
      this.logger?.error('delivery journal write failed', { error })
    })
    return write.then(() => record)
  }

  async flush() {
    return this.writing
  }

  async compact() {
    await this.flush()
    try {
      const lines = [...this.records.values()]
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
        .map((record) => JSON.stringify(record))
      const temporary = `${this.file}.tmp`
      await fs.writeFile(temporary, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8')
      await fs.rename(temporary, this.file)
    } catch (error) {
      this.logger?.error('delivery journal compaction failed', { error })
    }
  }
}
