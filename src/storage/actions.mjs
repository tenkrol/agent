/**
 * Journal of external actions whose outcome may be unknown after a crash.
 *
 * A task can send a result, mirror it to the assistant, or upload a file. If the
 * process dies between the action and its confirmation, repeating the action can
 * create a second external effect. This log records «начато» before the effect
 * and «подтверждено» after it, so resuming a task can ask the owner instead of
 * silently repeating.
 *
 * Append-only JSONL, last line per action id wins; a half-written line is skipped.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const VERSION = 1

export const ACTION = {
  started: 'started',
  confirmed: 'confirmed',
  unknown: 'unknown',
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

export class ActionLog {
  /**
   * @param {object} options - `file`, `logger`, `maxEntries`.
   */
  constructor({ file, logger, maxEntries = 5000 } = {}) {
    this.file = file
    this.logger = logger
    this.maxEntries = maxEntries
    /** @type {Map<string, object>} id → latest record. */
    this.records = new Map()
    this.writing = Promise.resolve()
    this.counter = 0
  }

  /** Read the file; junk lines are skipped. */
  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        try {
          const parsed = JSON.parse(line)
          if (parsed?.version !== VERSION || typeof parsed.id !== 'string') throw new Error('unexpected record')
          this.records.set(parsed.id, parsed)
        } catch {
          // Пропускаем неполную или чужую строку — история важнее, чем одна запись.
        }
      }
      this.compactMemory()
      this.logger?.info('action log loaded', { actions: this.records.size })
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn('action log unreadable, starting empty', { error })
    }
    return this
  }

  compactMemory() {
    if (this.records.size <= this.maxEntries) return
    const ordered = [...this.records.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    for (const record of ordered.slice(0, this.records.size - this.maxEntries)) this.records.delete(record.id)
  }

  id() {
    this.counter += 1
    return `a${Date.now().toString(36)}${this.counter.toString(36)}`
  }

  /** Record the start of an external action before performing it. */
  async begin({ taskId, kind, target, key } = {}) {
    const now = Date.now()
    const record = {
      version: VERSION,
      id: this.id(),
      taskId: taskId === undefined ? undefined : String(taskId),
      kind: String(kind ?? 'unknown'),
      target: target === undefined ? undefined : String(target),
      key: key === undefined ? undefined : String(key),
      status: ACTION.started,
      createdAt: now,
      updatedAt: now,
    }
    await this.#save(record)
    return record
  }

  /** Record a confirmation with the receipt the platform returned. */
  async confirm(id, { receipt } = {}) {
    return this.#patch(id, { status: ACTION.confirmed, confirmedAt: Date.now(), receipt })
  }

  /** Mark an action as having an unknown outcome. */
  async unknown(id, { reason } = {}) {
    return this.#patch(id, { status: ACTION.unknown, unknownAt: Date.now(), reason })
  }

  /**
   * Startup recovery: anything still «начато» did not get a confirmation.
   *
   * @returns {Promise<number>} how many actions were marked unknown.
   */
  async recover() {
    let count = 0
    for (const record of [...this.records.values()]) {
      if (record.status !== ACTION.started) continue
      await this.#patch(record.id, { status: ACTION.unknown, unknownAt: Date.now(), reason: 'перезапуск сервиса' })
      count += 1
    }
    return count
  }

  /** Actions of a task whose outcome is not confirmed: started or unknown. */
  unresolved(taskId) {
    const id = String(taskId)
    return [...this.records.values()].filter((record) => (
      String(record.taskId ?? '') === id && (record.status === ACTION.started || record.status === ACTION.unknown)
    ))
  }

  all(taskId) {
    const id = String(taskId)
    return [...this.records.values()].filter((record) => String(record.taskId ?? '') === id)
  }

  async #patch(id, patch) {
    const existing = this.records.get(id)
    if (!existing) return undefined
    const record = { ...existing, ...patch, version: VERSION, updatedAt: Date.now() }
    await this.#save(record)
    return record
  }

  /** Store and append durably. */
  #save(record) {
    this.records.set(record.id, record)
    this.compactMemory()
    const line = `${JSON.stringify(record)}\n`
    const write = this.writing.then(async () => {
      try {
        await appendDurable(this.file, line)
      } catch (error) {
        this.logger?.error('action log write failed', { error })
        throw error
      }
    })
    this.writing = write.catch(() => {})
    return write.then(() => record)
  }

  /** Wait for pending writes. */
  async flush() {
    return this.writing
  }

  /** Rewrite the file with one line per retained action. */
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
      this.logger?.error('action log compaction failed', { error })
    }
  }
}
