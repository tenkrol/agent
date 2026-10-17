/**
 * Реестр файлов контракта: входные материалы и результаты.
 *
 * fileId непрозрачен и не является путём; произвольные пути и URL контракт не
 * принимает. Файлы лежат в каталоге состояния (входные и результаты раздельно),
 * реестр — append-only JSONL. У каждой записи есть срок хранения: после него
 * файл не отдаётся (410), но запись остаётся для разбора.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const VERSION = 1
const DEFAULT_TTL_DAYS = 7

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

/** Сколько свободного места на диске (байт), если платформа умеет это сказать. */
export async function freeSpace(dir) {
  try {
    const stats = await fs.statfs(dir)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return undefined
  }
}

export class FileStore {
  /**
   * @param {object} options - `dir` (каталог файлов), `file` (реестр), `logger`,
   *   `inputTtlDays`, `resultTtlDays`.
   */
  constructor({ dir, file, logger, inputTtlDays = DEFAULT_TTL_DAYS, resultTtlDays = 14 } = {}) {
    this.dir = dir
    this.file = file
    this.logger = logger
    this.inputTtlDays = inputTtlDays
    this.resultTtlDays = resultTtlDays
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
          if (parsed?.version !== VERSION || typeof parsed.fileId !== 'string') throw new Error('unexpected record')
          this.records.set(parsed.fileId, parsed)
        } catch {
          // Неполная строка после сбоя пропускается.
        }
      }
      this.logger?.info('file registry loaded', { files: this.records.size })
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn('file registry unreadable, starting empty', { error })
    }
    return this
  }

  /** Save bytes and register them; returns the public metadata. */
  async create({ bytes, name, mime, direction = 'input', now = Date.now() } = {}) {
    if (!Buffer.isBuffer(bytes)) throw new TypeError('FileStore: нужны байты файла')
    const safeName = String(name ?? 'file').replace(/[^\p{L}\p{N}._ ()\-]/gu, '_').slice(0, 120) || 'file'
    const fileId = `f_${randomBytes(8).toString('hex')}`
    const targetDir = path.join(this.dir, direction)
    await fs.mkdir(targetDir, { recursive: true, mode: 0o700 })
    const filePath = path.join(targetDir, fileId)
    await fs.writeFile(filePath, bytes, { mode: 0o600 })
    const ttlDays = direction === 'result' ? this.resultTtlDays : this.inputTtlDays
    const record = {
      version: VERSION,
      fileId,
      name: safeName,
      mime: String(mime ?? 'application/octet-stream').slice(0, 160),
      size: bytes.length,
      direction,
      path: filePath,
      createdAt: now,
      expiresAt: now + ttlDays * 24 * 3600 * 1000,
    }
    this.records.set(fileId, record)
    const line = `${JSON.stringify(record)}\n`
    const write = this.writing.then(() => appendDurable(this.file, line))
    this.writing = write.catch((error) => this.logger?.error('file registry write failed', { error }))
    await write
    return record
  }

  /** Registry record, regardless of expiry. */
  get(fileId) {
    return this.records.get(String(fileId))
  }

  /**
   * Read a file by id.
   *
   * @returns {Promise<{ok: boolean, error?: 'not_found'|'expired', record?: object, bytes?: Buffer}>}
   */
  async read(fileId, now = Date.now()) {
    const record = this.get(fileId)
    if (!record) return { ok: false, error: 'not_found' }
    if (Number(record.expiresAt) > 0 && Number(record.expiresAt) <= now) return { ok: false, error: 'expired', record }
    try {
      const bytes = await fs.readFile(record.path)
      return { ok: true, record, bytes }
    } catch {
      return { ok: false, error: 'not_found', record }
    }
  }

  /** Mark expired records — for the diagnostics and cleanup. */
  expired(now = Date.now()) {
    return [...this.records.values()].filter((record) => Number(record.expiresAt) > 0 && Number(record.expiresAt) <= now)
  }
}
