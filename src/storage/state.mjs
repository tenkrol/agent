/**
 * Small JSON state files for the agent: the polling cursor and the per-chat
 * DSH session ids.
 *
 * One file, one key space, atomic writes and debounced saves — the same shape as
 * the chat bot's stores, so both are easy to read and to back up. A corrupt file
 * is reported and replaced rather than crashing the bot.
 */
import fs from 'node:fs/promises'
import { quarantineCorrupt, writeAtomic } from './atomic.mjs'

const VERSION = 1
const SAVE_DELAY_MS = 1000

export class StateStore {
  /**
   * @param {object} options - store options.
   * @param {string} options.file - JSON file used for persistence.
   * @param {object} [options.logger] - logger.
   * @param {number} [options.saveDelayMs] - debounce for writes.
   */
  constructor({ file, logger, saveDelayMs = SAVE_DELAY_MS } = {}) {
    this.file = file
    this.logger = logger
    this.saveDelayMs = saveDelayMs
    this.data = {}
    this.timer = undefined
    this.writing = Promise.resolve()
  }

  /** Read the file when it exists; a corrupt file is reported and replaced. */
  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (parsed?.version !== VERSION || typeof parsed.data !== 'object' || parsed.data === null) {
        throw new Error('unexpected file format')
      }
      this.data = parsed.data
      this.logger?.info('state loaded', { file: this.file, keys: Object.keys(this.data).length })
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Повреждённый или незнакомый файл откладываем в копию, чтобы данные не исчезли.
        this.logger?.warn('state file ignored', { file: this.file, error })
        await quarantineCorrupt(this.file, { logger: this.logger })
      }
    }
    return this
  }

  /** One value, with a fallback that is not stored. */
  get(key, fallback = undefined) {
    return Object.hasOwn(this.data, key) ? this.data[key] : fallback
  }

  /** Store one value and schedule a save. */
  set(key, value) {
    this.data[key] = value
    this.scheduleSave()
    return value
  }

  /** Forget one value and schedule a save. */
  delete(key) {
    if (Object.hasOwn(this.data, key)) {
      delete this.data[key]
      this.scheduleSave()
    }
  }

  /** Every key/value pair, for the rare sweep over namespaced keys. */
  entries() {
    return Object.entries(this.data)
  }

  scheduleSave() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.saveDelayMs)
    this.timer.unref?.()
  }

  /** Persist atomically and wait for the write. */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    // Serialize writers: two flushes must not race on the same temporary file.
    this.writing = this.writing.then(async () => {
      try {
        await writeAtomic(this.file, `${JSON.stringify({ version: VERSION, data: this.data }, null, 2)}\n`)
      } catch (error) {
        this.logger?.error('state save failed', { error })
      }
    })
    return this.writing
  }
}
