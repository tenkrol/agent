/**
 * Ключи идемпотентности ответов и отмены.
 *
 * Ключ постановки задачи живёт в записи задачи (PLA-13). Ответ на вопрос и
 * отмена — отдельные изменяющие запросы, поэтому их ключи хранятся здесь:
 * область (`reply`/`cancel`), ключ, задача, хэш тела и сохранённый ответ.
 * Повтор с тем же ключом возвращает прежний результат и не выполняет действие
 * второй раз; тот же ключ с другим телом — конфликт.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const VERSION = 1

/** A stable hash of the request body, to detect «тот же ключ, другое тело». */
export function bodyHash(body = {}) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32)
}

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

export class RequestStore {
  constructor({ file, logger } = {}) {
    this.file = file
    this.logger = logger
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
          if (parsed?.version !== VERSION || typeof parsed.key !== 'string') throw new Error('unexpected record')
          this.records.set(`${parsed.scope}:${parsed.key}`, parsed)
        } catch {
          // Неполная строка после сбоя пропускается.
        }
      }
      this.logger?.info('request keys loaded', { keys: this.records.size })
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn('request keys unreadable, starting empty', { error })
    }
    return this
  }

  /**
   * Find a previously handled request.
   *
   * @returns {{record?: object, conflict?: boolean}} the stored record or a conflict flag.
   */
  find(scope, key, hash) {
    const record = this.records.get(`${scope}:${key}`)
    if (!record) return {}
    if (hash !== undefined && record.hash !== hash) return { conflict: true, record }
    return { record }
  }

  /** Remember a handled request durably. */
  async remember(scope, key, { taskId, hash, response } = {}) {
    const record = {
      version: VERSION,
      scope: String(scope),
      key: String(key),
      taskId: taskId === undefined ? undefined : String(taskId),
      hash,
      response,
      at: Date.now(),
    }
    this.records.set(`${record.scope}:${record.key}`, record)
    const line = `${JSON.stringify(record)}\n`
    const write = this.writing.then(() => appendDurable(this.file, line))
    this.writing = write.catch((error) => this.logger?.error('request key write failed', { error }))
    await write
    return record
  }

  async flush() {
    return this.writing
  }
}
