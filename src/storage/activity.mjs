/**
 * Журнал активности агентов (E2). Append-only JSONL без секретов.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export class ActivityStore {
  constructor({ file, maxEntries = 5000, logger } = {}) {
    this.file = file
    this.maxEntries = maxEntries
    this.logger = logger
    this.events = []
    this.writing = Promise.resolve()
  }

  async load() {
    try {
      const text = await fs.readFile(this.file, 'utf8')
      this.events = text.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line) } catch { return undefined }
      }).filter(Boolean).slice(-this.maxEntries)
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn?.('activity load failed', { error })
    }
    return this
  }

  /** Записать событие; поля с undefined не сохраняются. */
  record(event = {}) {
    const clean = Object.fromEntries(Object.entries({ at: Date.now(), ...event }).filter(([, value]) => value !== undefined))
    this.events.push(clean)
    if (this.events.length > this.maxEntries) this.events = this.events.slice(-this.maxEntries)
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true }).catch(() => {})
      await fs.appendFile(this.file, `${JSON.stringify(clean)}\n`, 'utf8').catch((error) => this.logger?.warn?.('activity append failed', { error }))
    })
    return clean
  }

  recent({ limit = 50, agent, taskId } = {}) {
    let rows = this.events
    if (agent) rows = rows.filter((event) => event.agent === agent)
    if (taskId) rows = rows.filter((event) => event.taskId === taskId)
    return rows.slice(-Math.max(1, Math.min(500, Number(limit) || 50))).reverse()
  }

  async flush() {
    await this.writing
  }
}
