/**
 * Транзакционная очередь задач на встроенном `node:sqlite` (этап 2, PLA-20).
 *
 * Задача выдаётся ровно одному работнику через аренду с `generation`. Результат
 * устаревшей попытки отвергается: смена поколения при перезахвате делает старый
 * `complete` недействительным. Пока это примитивы этапа: бот и оркестратор
 * переключаются на них отдельным шагом после миграции.
 */
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  request_key TEXT UNIQUE,
  status TEXT NOT NULL,
  payload TEXT,
  lease_owner TEXT,
  lease_until INTEGER,
  generation INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  task_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  owner TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  status TEXT,
  PRIMARY KEY (task_id, generation)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  generation INTEGER,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS tasks_status_created ON tasks(status, created_at);
CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  enqueued_at INTEGER
);
`

const TERMINAL = new Set(['done', 'partial', 'failed', 'cancelled'])

export class SqliteTaskQueue {
  /**
   * @param {object} options - `file`, `logger`, `now`.
   */
  constructor({ file, logger, now = () => Date.now() } = {}) {
    if (!file) throw new Error('очереди нужен путь к файлу')
    this.logger = logger
    this.now = now
    this.db = new DatabaseSync(file)
    this.db.exec(SCHEMA)
  }

  /** Поставить задачу; повтор с тем же requestKey возвращает существующую. */
  enqueue({ id, requestKey, payload = {}, status = 'queued', now = this.now() } = {}) {
    if (!id) throw new Error('задаче нужен id')
    const body = JSON.stringify(payload)
    this.db.prepare(`
      INSERT OR IGNORE INTO tasks (id, request_key, status, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, requestKey ?? null, status, body, now, now)
    const row = requestKey
      ? this.db.prepare('SELECT * FROM tasks WHERE request_key = ?').get(requestKey)
      : this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    return this.#row(row)
  }

  /** Захватить одну задачу; возвращает запись с новым generation или undefined. */
  claim({ owner, ttlMs = 60_000, now = this.now() } = {}) {
    if (!owner) throw new Error('аренде нужен owner')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare(`
        SELECT * FROM tasks
        WHERE status = 'queued'
           OR (status = 'running' AND (lease_until IS NULL OR lease_until < ?))
        ORDER BY created_at ASC
        LIMIT 1
      `).get(now)
      if (!row) {
        this.db.exec('COMMIT')
        return undefined
      }
      const generation = Number(row.generation) + 1
      this.db.prepare(`
        UPDATE tasks SET status = 'running', lease_owner = ?, lease_until = ?,
          generation = ?, updated_at = ? WHERE id = ?
      `).run(owner, now + ttlMs, generation, now, row.id)
      this.db.prepare(`
        INSERT INTO attempts (task_id, generation, owner, started_at, heartbeat_at, status)
        VALUES (?, ?, ?, ?, ?, 'running')
      `).run(row.id, generation, owner, now, now)
      this.db.prepare('INSERT INTO events (task_id, generation, type, at, data) VALUES (?, ?, ?, ?, ?)')
        .run(row.id, generation, 'claimed', now, JSON.stringify({ owner }))
      this.db.exec('COMMIT')
      return this.get(row.id)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Продлить аренду только своей попытки и только пока она жива. */
  heartbeat({ taskId, generation, owner, ttlMs = 60_000, now = this.now() } = {}) {
    const result = this.db.prepare(`
      UPDATE tasks SET lease_until = ?, updated_at = ?
      WHERE id = ? AND generation = ? AND lease_owner = ? AND status = 'running'
        AND lease_until >= ?
    `).run(now + ttlMs, now, taskId, generation, owner, now)
    if (result.changes > 0) {
      this.db.prepare('UPDATE attempts SET heartbeat_at = ? WHERE task_id = ? AND generation = ?')
        .run(now, taskId, generation)
    }
    return result.changes > 0
  }

  /** Завершить попытку; устаревший generation отвергается. */
  complete({ taskId, generation, owner, status, payload, now = this.now() } = {}) {
    if (!TERMINAL.has(status)) throw new Error(`недопустимый терминальный статус: ${status}`)
    // Fencing: только владелец живой аренды и только один раз.
    const result = this.db.prepare(`
      UPDATE tasks SET status = ?, payload = COALESCE(?, payload), lease_owner = NULL,
        lease_until = NULL, updated_at = ?
      WHERE id = ? AND generation = ? AND lease_owner = ? AND status = 'running'
        AND lease_until >= ?
    `).run(status, payload === undefined ? null : JSON.stringify(payload), now, taskId, generation, owner, now)
    if (result.changes === 0) return { ok: false, stale: true }
    this.db.prepare('UPDATE attempts SET status = ? WHERE task_id = ? AND generation = ?')
      .run(status, taskId, generation)
    this.db.prepare('INSERT INTO events (task_id, generation, type, at, data) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, generation, 'completed', now, JSON.stringify({ status }))
    return { ok: true, stale: false }
  }

  /** Вернуть задачу в очередь (например, после отмены работника). */
  release({ taskId, generation, owner, now = this.now() } = {}) {
    const result = this.db.prepare(`
      UPDATE tasks SET status = 'queued', lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ? AND generation = ? AND lease_owner = ?
    `).run(now, taskId, generation, owner)
    return result.changes > 0
  }

  /** Восстановить задачи с истёкшей арендой: попытка помечается потерянной, задача — в очередь. */
  recoverExpired({ now = this.now() } = {}) {
    const rows = this.db.prepare(`
      SELECT id, generation FROM tasks
      WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?
    `).all(now)
    for (const row of rows) {
      this.db.prepare("UPDATE attempts SET status = 'lost' WHERE task_id = ? AND generation = ?")
        .run(row.id, row.generation)
      this.db.prepare(`
        UPDATE tasks SET status = 'queued', lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND generation = ?
      `).run(now, row.id, row.generation)
      this.db.prepare('INSERT INTO events (task_id, generation, type, at) VALUES (?, ?, ?, ?)')
        .run(row.id, row.generation, 'lease_expired', now)
    }
    return rows.length
  }

  /** Сменить статус без терминального завершения (парковка вопроса/плана). */
  setStatus({ taskId, generation, owner, status, now = this.now() } = {}) {
    const result = this.db.prepare(`
      UPDATE tasks SET status = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ? AND generation = ? AND lease_owner = ? AND status = 'running' AND lease_until >= ?
    `).run(status, now, taskId, generation, owner, now)
    return result.changes > 0
  }

  /** Задача всё ещё принадлежит этой попытке? Проверка перед побочными эффектами. */
  owns({ taskId, generation, owner, now = this.now() } = {}) {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM tasks WHERE id = ? AND generation = ? AND lease_owner = ?
        AND status = 'running' AND lease_until >= ?
    `).get(taskId, generation, owner, now))
  }

  /** Вернуть задачу в queued с новым payload и новым generation. */
  requeue({ taskId, payload, requestKey, now = this.now() } = {}) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId)
      if (!row) {
        this.db.exec('ROLLBACK')
        return { ok: false, missing: true }
      }
      if (row.status === 'running' && row.lease_until >= now) {
        this.db.exec('ROLLBACK')
        return { ok: false, busy: true }
      }
      const body = payload === undefined ? row.payload : JSON.stringify(payload)
      if (row.status === 'queued' && body === row.payload && (requestKey === undefined || requestKey === row.request_key)) {
        this.db.exec('COMMIT')
        return { ok: true, duplicate: true, generation: Number(row.generation) }
      }
      const generation = Number(row.generation) + 1
      this.db.prepare(`
        UPDATE tasks SET status = 'queued', payload = ?, request_key = COALESCE(?, request_key),
          lease_owner = NULL, lease_until = NULL, generation = ?, updated_at = ? WHERE id = ?
      `).run(body, requestKey ?? null, generation, now, taskId)
      this.db.prepare("UPDATE attempts SET status = 'requeued' WHERE task_id = ? AND status = 'running'").run(taskId)
      this.db.prepare('INSERT INTO events (task_id, generation, type, at, data) VALUES (?, ?, ?, ?, ?)')
        .run(taskId, generation, 'requeued', now, JSON.stringify({ requestKey }))
      this.db.exec('COMMIT')
      return { ok: true, duplicate: false, generation }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Отменить все queued: после этого claim их не выдаст. */
  cancelAll({ now = this.now() } = {}) {
    return this.db.prepare("UPDATE tasks SET status = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE status = 'queued'").run(now).changes
  }

  /**
   * Атомарно принять результат: терминальный статус задачи + outbox в одной транзакции.
   * Доставка после этого читает принятый outbox и не пересчитывает задачу.
   */
  accept({ taskId, generation, owner, status, payload, outbox, now = this.now() } = {}) {
    if (!TERMINAL.has(status)) throw new Error('accept: нужен терминальный статус')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.db.prepare(`
        UPDATE tasks SET status = ?, payload = COALESCE(?, payload), lease_owner = NULL,
          lease_until = NULL, updated_at = ?
        WHERE id = ? AND generation = ? AND lease_owner = ? AND status = 'running' AND lease_until >= ?
      `).run(status, payload === undefined ? null : JSON.stringify(payload), now, taskId, generation, owner, now)
      if (result.changes === 0) {
        this.db.exec('ROLLBACK')
        return { ok: false, stale: true }
      }
      if (outbox) {
        this.db.prepare(`INSERT OR REPLACE INTO outbox (event_id, task_id, payload, status, created_at) VALUES (?, ?, ?, 'pending', ?)`)
          .run(outbox.eventId, taskId, JSON.stringify(outbox), now)
      }
      this.db.prepare('UPDATE attempts SET status = ? WHERE task_id = ? AND generation = ?').run(status, taskId, generation)
      this.db.prepare('INSERT INTO events (task_id, generation, type, at, data) VALUES (?, ?, ?, ?, ?)')
        .run(taskId, generation, 'accepted', now, JSON.stringify({ status, outbox: Boolean(outbox) }))
      this.db.exec('COMMIT')
      return { ok: true, stale: false }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Атомарно припарковать задачу (вопрос/план): статус awaiting_owner, payload и
   * outbox в одной транзакции, аренда снимается; дальнейшая доставка читает outbox.
   */
  park({ taskId, generation, owner, payload, outbox, now = this.now() } = {}) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.db.prepare(`
        UPDATE tasks SET status = 'awaiting_owner', payload = COALESCE(?, payload),
          lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND generation = ? AND lease_owner = ? AND status = 'running' AND lease_until >= ?
      `).run(payload === undefined ? null : JSON.stringify(payload), now, taskId, generation, owner, now)
      if (result.changes === 0) {
        this.db.exec('ROLLBACK')
        return { ok: false, stale: true }
      }
      if (outbox) {
        this.db.prepare(`INSERT OR REPLACE INTO outbox (event_id, task_id, payload, status, created_at) VALUES (?, ?, ?, 'pending', ?)`)
          .run(outbox.eventId, taskId, JSON.stringify(outbox), now)
      }
      this.db.prepare("UPDATE attempts SET status = 'awaiting_owner' WHERE task_id = ? AND generation = ?").run(taskId, generation)
      this.db.exec('COMMIT')
      return { ok: true, stale: false }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Сверить статус с журналом после crash: без owner, только queued/running. */
  reconcile({ taskId, status, now = this.now() } = {}) {
    const result = this.db.prepare(`
      UPDATE tasks SET status = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(status, now, taskId)
    return result.changes > 0
  }

  /** Принятые, но ещё не поставленные в доставку события. */
  pendingOutbox({ limit = 50 } = {}) {
    return this.db.prepare("SELECT * FROM outbox WHERE status = 'pending' ORDER BY created_at LIMIT ?").all(limit)
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }))
  }

  markOutboxEnqueued(eventId, { now = this.now() } = {}) {
    return this.db.prepare("UPDATE outbox SET status = 'enqueued', enqueued_at = ? WHERE event_id = ? AND status = 'pending'").run(now, eventId).changes > 0
  }

  /** Все незавершённые (queued/running) для восстановления без новых запросов. */
  listPending() {
    return this.db.prepare("SELECT * FROM tasks WHERE status IN ('queued', 'running') ORDER BY created_at ASC").all().map((row) => this.#row(row))
  }

  /** Ближайший конец аренды: сколько ждать до повторного claim. */
  nextLeaseAt() {
    const row = this.db.prepare("SELECT MIN(lease_until) AS at FROM tasks WHERE status = 'running' AND lease_until IS NOT NULL").get()
    return row?.at ?? undefined
  }

  /** Сколько задач ожидает в очереди. */
  count() {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'queued'").get().n) || 0
  }

  /** Снять задачу из очереди (отмена до запуска). */
  cancel({ taskId, now = this.now() } = {}) {
    return this.db.prepare("UPDATE tasks SET status = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'queued'").run(now, taskId).changes > 0
  }

  get(id) {
    return this.#row(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id))
  }

  attempts(taskId) {
    return this.db.prepare('SELECT * FROM attempts WHERE task_id = ? ORDER BY generation').all(taskId)
  }

  close() {
    this.db.close()
  }

  #row(row) {
    if (!row) return undefined
    return {
      ...row,
      generation: Number(row.generation),
      leaseUntil: row.lease_until,
      leaseOwner: row.lease_owner,
      payload: row.payload ? JSON.parse(row.payload) : {},
    }
  }
}
