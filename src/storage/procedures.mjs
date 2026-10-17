/**
 * Хранение процедур и их версий (PLA-16).
 *
 * Один JSON-файл, атомарная запись, версия схемы. Версии неизменяемы после
 * активации; черновик можно дополнять. Лимиты и статусы проверяет домен
 * procedures, хранилище только сохраняет и отдаёт данные.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { quarantineCorrupt, writeAtomic } from './atomic.mjs'

const VERSION = 1

export class ProceduresStore {
  constructor({ file, logger, maxVersions = 20 } = {}) {
    this.file = file
    this.logger = logger
    this.maxVersions = maxVersions
    this.data = { version: VERSION, nextId: 1, procedures: {} }
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (parsed?.version !== VERSION || typeof parsed.procedures !== 'object' || parsed.procedures === null) {
        throw new Error('unexpected procedures file')
      }
      this.data = {
        version: VERSION,
        nextId: Number(parsed.nextId) || 1,
        procedures: parsed.procedures,
      }
      this.logger?.info('procedures loaded', { count: Object.keys(this.data.procedures).length })
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn('procedures file ignored', { error })
        await quarantineCorrupt(this.file, { logger: this.logger })
      }
    }
    return this
  }

  all() {
    return Object.values(this.data.procedures).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  }

  get(nameOrId) {
    const key = String(nameOrId)
    return this.data.procedures[key] ?? Object.values(this.data.procedures).find((item) => item.name === key)
  }

  nextId() {
    const id = `p${this.data.nextId}`
    this.data.nextId += 1
    return id
  }

  async create({ name, versions, activeVersion }) {
    const now = Date.now()
    const record = {
      id: this.nextId(),
      name: String(name),
      activeVersion: activeVersion ?? null,
      versions,
      createdAt: now,
      updatedAt: now,
    }
    this.data.procedures[record.id] = record
    await this.save()
    return record
  }

  async update(id, patch = {}) {
    const record = this.data.procedures[id]
    if (!record) return undefined
    Object.assign(record, patch, { updatedAt: Date.now() })
    await this.save()
    return record
  }

  async remove(id) {
    const record = this.data.procedures[id]
    if (!record) return false
    record.removedAt = Date.now()
    record.versions = record.versions.map((version) => ({ ...version, status: 'archived' }))
    record.activeVersion = null
    await this.save()
    return true
  }

  async save() {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await writeAtomic(this.file, `${JSON.stringify(this.data, null, 1)}\n`)
    } catch (error) {
      this.logger?.error('procedures save failed', { error })
    }
  }
}
