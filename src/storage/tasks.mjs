/**
 * The task journal: what was asked, how it ended, what it cost.
 *
 * Append-only JSONL on disk (each state change is one line, the last line for an
 * id wins) and a small in-memory index for the commands. That keeps a crash from
 * losing history — a half-written line is skipped on load — and keeps `/tasks`
 * instant without parsing the whole file every time.
 *
 * С версии 2 журнал — это ещё и постоянная очередь: принятая задача сначала
 * записывается как `queued` (долговечно, с fsync), и только потом попадает в
 * память и на выполнение. Каждая смена состояния несёт время и причину в
 * `transitions`, поэтому после перезапуска видно, где именно остановилась задача.
 * Старые статусы (`awaiting_reply`, `timeout`, `expired`) переносятся при
 * загрузке: первый — в состояние, два других — в состояние + причину.
 */
import { randomInt } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const VERSION = 2

/** States a task can be in. */
export const STATUS = {
  queued: 'queued',
  running: 'running',
  awaiting: 'awaiting_owner',
  awaiting_owner: 'awaiting_owner',
  verifying: 'verifying',
  done: 'done',
  partial: 'partial',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
  // Совместимость с прежними именами: терминальные статусы теперь различаются reason.
  timeout: 'failed',
  expired: 'cancelled',
}

/** How legacy statuses map onto the new ones. */
export const LEGACY_STATUS = {
  awaiting_reply: { status: STATUS.awaiting_owner },
  timeout: { status: STATUS.failed, reason: 'timeout' },
  expired: { status: STATUS.cancelled, reason: 'expired' },
}

/** Terminal states never leave the archive. */
export const TERMINAL = new Set([STATUS.done, STATUS.partial, STATUS.failed, STATUS.cancelled])

/** Allowed transitions: the machine that makes "где остановилась задача" meaningful. */
export const TRANSITIONS = {
  queued: [STATUS.running, STATUS.cancelled, STATUS.interrupted],
  running: [STATUS.done, STATUS.failed, STATUS.cancelled, STATUS.interrupted, STATUS.awaiting_owner, STATUS.verifying],
  awaiting_owner: [STATUS.queued, STATUS.cancelled],
  verifying: [STATUS.done, STATUS.partial, STATUS.failed, STATUS.cancelled, STATUS.interrupted, STATUS.running, STATUS.awaiting_owner],
  interrupted: [STATUS.queued, STATUS.cancelled],
  done: [],
  partial: [],
  failed: [],
  cancelled: [],
}

/** A one-line label for the status, for messages and lists. */
const STATUS_LABEL = {
  queued: '🕓 в очереди',
  running: '⏳ выполняется',
  awaiting_owner: '❓ ждёт ответа',
  verifying: '🔎 проверяется',
  done: '✅ выполнена',
  partial: '⚠️ выполнена частично',
  failed: '⚠️ с ошибкой',
  cancelled: '⛔ отменена',
  interrupted: '⏸ прервана',
}

export { STATUS_LABEL }

/**
 * The label for one record, taking its reason into account.
 *
 * `timeout` and `expired` are no longer separate states, but the owner must still
 * see why the task ended the way it did.
 */
export function statusLabel(record) {
  if (record?.status === STATUS.failed && record.reason === 'timeout') return '⌛ по таймауту'
  if (record?.status === STATUS.cancelled && record.reason === 'expired') return '🕓 ответа не дождалась'
  return STATUS_LABEL[record?.status] ?? String(record?.status ?? 'неизвестно')
}

/** Throw when a transition is not allowed; callers decide what to do next. */
export function assertTransition(from, to) {
  if (from === to) return
  const allowed = TRANSITIONS[from]
  if (!allowed) throw new Error(`неизвестное состояние «${from}»`)
  if (!allowed.includes(to)) throw new Error(`переход «${from}» → «${to}» недопустим`)
}

/** Fields that make a queued record re-runnable after a restart. */
const JOB_FIELDS = [
  'kind',
  'requestId',
  'revision',
  'retry',
  'chatId',
  'userId',
  'text',
  'attachments',
  'replyToMessageId',
  'bridgeFrom',
  'viaVoice',
  'variantsMode',
  'freshSession',
  'scheduledFrom',
  'retryOf',
  'sessionId',
  'procedure',
  'route',
  'forceDsh',
  'facts',
  'rootTaskId',
  'resultVersion',
  'revisionOf',
  'revisionContext',
  'resultFiles',
  'resultSummary',
]

/** Add one durable line to an append-only file and sync it to disk. */
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

/** Sync a directory after a rename, when the platform supports it. */
async function syncDir(dir) {
  try {
    const handle = await fs.open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Не на всех платформах каталог можно синхронизировать — это не ошибка.
  }
}

export class TaskJournal {
  /**
   * @param {object} options - journal options.
   * @param {string} options.file - JSONL file.
   * @param {object} [options.logger] - logger.
   * @param {number} [options.maxEntries] - how many tasks stay in memory and on disk.
   */
  constructor({ file, logger, maxEntries = 2000 } = {}) {
    this.file = file
    this.logger = logger
    this.maxEntries = maxEntries
    /** @type {Map<string, object>} id → latest record. */
    this.records = new Map()
    /** @type {Map<string, string>} requestKey → id. */
    this.requestKeys = new Map()
    this.writing = Promise.resolve()
    this.counter = 0
    this.nextOrder = 1
  }

  /** Read the file, last line per id wins; junk lines are skipped. */
  async load() {
    let raw = ''
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger?.warn('task journal unreadable', { file: this.file, error })
      return this
    }
    let skipped = 0
    let migrated = 0
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line)
        if (![1, VERSION].includes(parsed?.version) || typeof parsed.id !== 'string') throw new Error('unexpected record')
        const record = this.#normalise(parsed)
        if (parsed.version !== VERSION) migrated += 1
        this.records.set(record.id, record)
      } catch {
        skipped += 1
      }
    }
    this.#rebuildOrder()
    this.compactMemory()
    this.logger?.info('task journal loaded', { tasks: this.records.size, skipped, migrated })
    return this
  }

  /** Migrate one record to the current schema, if needed. */
  #normalise(parsed) {
    const record = { version: VERSION, ...parsed }
    if (parsed.version === 1) {
      const legacy = LEGACY_STATUS[record.status]
      if (legacy) {
        record.status = legacy.status
        if (legacy.reason) record.reason = legacy.reason
      }
      record.transitions = []
      if (record.request === undefined && typeof record.brief === 'string') record.request = record.brief
    }
    if (!Array.isArray(record.transitions)) record.transitions = []
    return record
  }

  /** Assign queue order to records that predate it, and rebuild the key index. */
  #rebuildOrder() {
    const ordered = [...this.records.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    let order = 1
    this.requestKeys = new Map()
    for (const record of ordered) {
      if (!Number.isFinite(record.order)) record.order = order
      order = Math.max(order, record.order + 1)
      if (record.requestKey && !this.requestKeys.has(record.requestKey)) {
        this.requestKeys.set(record.requestKey, record.id)
      } else if (record.requestKey) {
        this.logger?.warn('duplicate requestKey in journal', { requestKey: record.requestKey, id: record.id })
      }
    }
    this.nextOrder = order
  }

  /** Keep only the newest `maxEntries` tasks in memory. */
  compactMemory() {
    if (this.records.size <= this.maxEntries) return
    const ordered = [...this.records.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    for (const record of ordered.slice(0, this.records.size - this.maxEntries)) this.records.delete(record.id)
  }

  /**
   * A fresh id, readable in a chat and unique across restarts.
   *
   * The counter starts from a random seed, so two processes that hand out ids in
   * the same second of the day cannot collide — which matters because the id
   * also names the parked question and the task cgroup.
   */
  nextId(date = new Date()) {
    if (this.counter === 0) this.counter = randomInt(1, 46_656)
    this.counter += 1
    const stamp = date.toISOString().slice(11, 19).replace(/:/g, '')
    return `${stamp}-${this.counter.toString(36)}`
  }

  /** A new queue position. */
  nextQueueOrder() {
    return this.nextOrder++
  }

  /** Open a task record as it used to be: an already running job. */
  async open({ id, chatId, userId, brief = '', sessionId, scheduledFrom, ...rest } = {}) {
    const now = Date.now()
    const record = {
      version: VERSION,
      id,
      chatId: chatId === undefined ? undefined : String(chatId),
      userId: userId === undefined ? undefined : String(userId),
      status: STATUS.running,
      brief: String(brief ?? '').slice(0, 300),
      request: rest.request === undefined ? String(brief ?? '').slice(0, 4000) : rest.request,
      sessionId,
      scheduledFrom,
      createdAt: now,
      updatedAt: now,
      order: this.nextQueueOrder(),
      transitions: [{ at: now, from: undefined, to: STATUS.running, reason: 'создана' }],
    }
    return this.save(record)
  }

  /**
   * Accept a task: write it as `queued` durably before it exists in memory.
   *
   * @param {object} job - task fields (`text`, `attachments`, …).
   * @returns {Promise<{record: object, duplicate: boolean, conflict?: boolean}>} the stored record.
   * @throws {Error} when the durable write fails.
   */
  async openQueued(job = {}, { now = Date.now() } = {}) {
    const id = job.id ?? this.nextId()
    const key = job.requestKey === undefined ? undefined : String(job.requestKey)
    if (key) {
      const existing = this.findByRequestKey(key)
      if (existing) {
        const sameText = String(existing.text ?? existing.request ?? '') === String(job.text ?? '')
        return { record: existing, duplicate: true, conflict: !sameText }
      }
    }
    const record = {
      version: VERSION,
      id,
      status: STATUS.queued,
      chatId: job.chatId === undefined ? undefined : String(job.chatId),
      userId: job.userId === undefined ? undefined : String(job.userId),
      brief: String(job.brief ?? job.text ?? '').slice(0, 300),
      request: String(job.text ?? '').slice(0, 4000),
      text: String(job.text ?? ''),
      enqueuedAt: now,
      createdAt: now,
      updatedAt: now,
      order: this.nextQueueOrder(),
      requestKey: key,
      transitions: [{ at: now, from: undefined, to: STATUS.queued, reason: 'принята' }],
    }
    for (const field of JOB_FIELDS) {
      if (job[field] !== undefined) record[field] = job[field]
    }
    await this.save(record, { durable: true })
    if (key) this.requestKeys.set(key, id)
    return { record, duplicate: false }
  }

  /** Every task waiting for the single worker, in queue order. */
  pending() {
    return [...this.records.values()]
      .filter((record) => record.status === STATUS.queued)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }

  /** Find a task by its idempotency key. */
  findByRequestKey(key) {
    const id = this.requestKeys.get(String(key))
    return id === undefined ? undefined : this.records.get(id)
  }

  /**
   * Move one task to a new state, recording time, reason and actor.
   *
   * @param {string} id - task id.
   * @param {string} to - target state.
   * @param {object} [options] - `reason`, `actor`, `patch`, `durable`.
   * @returns {Promise<object|undefined>} the updated record.
   */
  async transition(id, to, { reason, actor = 'system', patch = {}, durable = true } = {}) {
    const existing = this.records.get(id)
    if (!existing) return undefined
    const from = existing.status
    if (from !== to) assertTransition(from, to)
    const at = Date.now()
    const record = {
      ...existing,
      ...patch,
      version: VERSION,
      status: to,
      reason: reason ?? (from === to ? existing.reason : undefined),
      updatedAt: at,
      transitions: from === to
        ? existing.transitions
        : [...(existing.transitions ?? []), { at, from, to, reason: reason ?? '', actor }],
    }
    if (TERMINAL.has(to)) record.finishedAt = patch.finishedAt ?? at
    await this.save(record, { durable })
    return record
  }

  /** Turn an answered task back into a queued one, preserving its id. */
  async requeue(id, { reason = 'продолжение', patch = {} } = {}) {
    const existing = this.records.get(id)
    if (!existing) return undefined
    return this.transition(id, STATUS.queued, {
      reason,
      actor: 'owner',
      patch: {
        ...patch,
        order: this.nextQueueOrder(),
        enqueuedAt: Date.now(),
        question: undefined,
        variants: undefined,
        askedAt: undefined,
      },
    })
  }

  /** Remember the last visible progress of a running task (not durable). */
  async progress(id, { steps, tool, at = Date.now() } = {}) {
    const existing = this.records.get(id)
    if (!existing) return undefined
    const record = {
      ...existing,
      version: VERSION,
      lastProgress: { steps, tool, at },
      updatedAt: at,
    }
    return this.save(record, { durable: false })
  }

  /**
   * Recover after a restart: unfinished runs become `interrupted`.
   *
   * @returns {Promise<object[]>} the tasks that were interrupted.
   */
  async recover() {
    const interrupted = []
    for (const record of [...this.records.values()]) {
      if (record.status !== STATUS.running && record.status !== STATUS.verifying) continue
      const updated = await this.transition(record.id, STATUS.interrupted, {
        reason: 'перезапуск сервиса',
        actor: 'recovery',
        patch: { interruptedAt: Date.now() },
      })
      if (updated) interrupted.push(updated)
    }
    return interrupted
  }

  /** Merge a patch into one task. Status changes go through the state machine. */
  async update(id, patch = {}) {
    const existing = this.records.get(id)
    if (!existing) return undefined
    if (patch.status !== undefined && patch.status !== existing.status) {
      const { status, reason, ...rest } = patch
      return this.transition(id, status, { reason, patch: rest })
    }
    const record = { ...existing, ...patch, version: VERSION, updatedAt: Date.now() }
    return this.save(record)
  }

  /** Close a task with a final status. */
  async close(id, patch = {}) {
    const status = patch.status ?? STATUS.done
    const { status: _ignored, ...rest } = patch
    return this.transition(id, status, {
      reason: rest.reason ?? rest.error,
      patch: { ...rest, finishedAt: rest.finishedAt ?? Date.now() },
    })
  }

  /** One record, or undefined. */
  get(id) {
    return this.records.get(id)
  }

  /** Newest first. */
  recent(limit = 10) {
    return [...this.records.values()]
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, limit)
  }

  /** Every task waiting for the owner's answer. */
  awaiting() {
    return [...this.records.values()].filter((record) => record.status === STATUS.awaiting_owner)
  }

  /** Store in memory and append to disk. */
  save(record, { durable = false } = {}) {
    this.records.set(record.id, record)
    this.compactMemory()
    const line = `${JSON.stringify(record)}\n`
    const write = this.writing.then(async () => {
      try {
        if (durable) {
          await appendDurable(this.file, line)
        } else {
          await fs.mkdir(path.dirname(this.file), { recursive: true })
          await fs.appendFile(this.file, line, 'utf8')
        }
      } catch (error) {
        this.logger?.error('task journal write failed', { error })
        throw error
      }
    })
    // Цепочка записей не должна ломаться из-за одной ошибки, но вызывающий обязан её увидеть.
    this.writing = write.catch(() => {})
    return write.then(() => record)
  }

  /** Wait for pending writes. */
  async flush() {
    return this.writing
  }

  /**
   * Rewrite the file with one line per retained task.
   *
   * Called at startup so the append log cannot grow without bound.
   */
  async compact() {
    await this.flush()
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const lines = [...this.records.values()]
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
        .map((record) => JSON.stringify(record))
      const temporary = `${this.file}.tmp`
      await fs.writeFile(temporary, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8')
      await syncDir(path.dirname(this.file)).catch(() => {})
      await fs.rename(temporary, this.file)
      this.logger?.info('task journal compacted', { tasks: lines.length })
    } catch (error) {
      this.logger?.error('task journal compaction failed', { error })
    }
  }
}

/** A short, human label for one task. */
export function describeTask(record, { files = true } = {}) {
  const when = new Date(record.createdAt ?? Date.now())
  const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
  const parts = [`${statusLabel(record)} · ${record.id} · ${time}`]
  if (record.brief) parts.push(`   ${record.brief}`)
  if ([STATUS.done, STATUS.partial, STATUS.failed].includes(record.status)) {
    const seconds = record.durationMs ? `${Math.round(record.durationMs / 1000)} с` : '—'
    const usd = record.usd === undefined ? '' : ` · ${record.usd < 0.01 ? `$${record.usd.toFixed(4)}` : `$${record.usd.toFixed(3)}`}`
    parts.push(`   ${seconds}, шагов ${record.steps ?? 0}, токенов ${(record.tokens?.total ?? 0).toLocaleString('ru-RU')}${usd}`)
  }
  if (record.status === STATUS.interrupted) {
    const last = record.lastProgress
    if (last) parts.push(`   остановилась на шаге ${last.steps ?? 0}${last.tool ? ` (${last.tool})` : ''}`)
    if (Array.isArray(record.partialFiles) && record.partialFiles.length > 0) {
      parts.push(`   сохранились файлы: ${record.partialFiles.slice(0, 5).join(', ')}`)
    }
  }
  if (files && Array.isArray(record.files) && record.files.length > 0) parts.push(`   файлы: ${record.files.join(', ')}`)
  if (record.error) parts.push(`   ошибка: ${String(record.error).slice(0, 200)}`)
  return parts.join('\n')
}
