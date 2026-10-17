/**
 * Long-term memory: durable facts about the owner and their work.
 *
 * Схема 2 (PLA-17): у факта есть вид (`preference`, `temporary`, `task`),
 * происхождение (`source`/`owner`), предмет (`subject`), область (`scope`),
 * срок актуальности и статус. Новый факт с тем же предметом и областью заменяет
 * действующий: прежний остаётся в истории, но не попадает в задачи.
 *
 * Факты приходят из `memory.md` после задачи и от владельца командами. Старая
 * схема версии 1 читается и переносится с резервной копией `memory.json.v1.bak`.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { quarantineCorrupt, writeAtomic } from './atomic.mjs'
import { containsSecret, redactSecrets } from '../secrets/guard.mjs'

/** Hard caps: memory must never become a second unbounded context. */
export const MAX_FACTS = 120
export const MAX_FACT_CHARS = 300
export const MAX_RENDER_CHARS = 3000
export const MAX_HISTORY = 500

/** A line in `memory.md` that carries a fact, optionally with a subject. */
const FACT_LINE = /^\s*[-*•]\s+(?:(?:\[(?<subject>[^\]]{1,60})\]|(?<subject2>[a-zа-я0-9_-]{1,60}):)\s*)?(?<text>.+?)\s*$/i

/** Normalised form used for de-duplication. */
const normalise = (text) => String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

/** Trim a fact to something that belongs in a prompt. */
const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS)

/** A fact is current when it is active and its validity period covers now. */
const isCurrent = (fact, now) => fact.status === 'active'
  && (!fact.validFrom || fact.validFrom <= now)
  && (!fact.validUntil || fact.validUntil > now)

/** Relevance by shared words; empty task text means «only general preferences». */
function relevant(fact, words) {
  if (words.length === 0) return fact.scope?.type === 'global'
  const text = normalise(fact.text)
  return words.some((word) => text.includes(word))
}

export class MemoryStore {
  /**
   * @param {object} options - `file`, `logger`, `maxFacts`, `historyMax`, `now`.
   */
  constructor({ file, logger, maxFacts = MAX_FACTS, historyMax = MAX_HISTORY, now = () => new Date() } = {}) {
    this.file = file
    this.logger = logger
    this.maxFacts = maxFacts
    this.historyMax = historyMax
    this.now = now
    this.facts = []
  }

  /** Read facts from disk; a broken file is reported and starts empty. */
  async load() {
    let raw
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn('memory file unreadable, starting empty', { error })
      return this
    }
    let payload
    try {
      payload = JSON.parse(raw)
    } catch (error) {
      this.logger?.warn('memory file corrupt, quarantined', { error })
      await quarantineCorrupt(this.file, { logger: this.logger })
      return this
    }
    if (payload?.version === 1) {
      // Старая схема: плоский список. Перед миграцией — копия.
      await fs.copyFile(this.file, `${this.file}.v1.bak`).catch(() => {})
      const now = this.now().getTime()
      this.facts = (Array.isArray(payload.facts) ? payload.facts : []).map((fact, index) => ({
        id: String(fact.id ?? `f${index + 1}`),
        text: clean(fact.text),
        kind: 'preference',
        subject: undefined,
        scope: { type: 'global', value: null },
        source: fact.source ? String(fact.source).slice(0, 60) : 'agent',
        owner: 'agent',
        createdAt: Number(fact.createdAt) || now,
        validFrom: Number(fact.createdAt) || now,
        validUntil: null,
        status: 'active',
        supersedes: null,
        supersededBy: null,
      })).filter((fact) => fact.text !== '')
      await this.save()
      this.logger?.info('memory migrated to version 2', { facts: this.facts.length })
    } else if (payload?.version === 2 && Array.isArray(payload.facts)) {
      this.facts = payload.facts
        .filter((fact) => fact && typeof fact.text === 'string' && fact.text.trim() !== '')
        .map((fact) => ({
          id: String(fact.id ?? `f${Date.now().toString(36)}`),
          text: clean(fact.text),
          kind: ['preference', 'temporary', 'task'].includes(fact.kind) ? fact.kind : 'preference',
          subject: fact.subject ? String(fact.subject).slice(0, 60) : undefined,
          scope: fact.scope && typeof fact.scope === 'object' ? { type: String(fact.scope.type ?? 'global'), value: fact.scope.value ?? null } : { type: 'global', value: null },
          source: fact.source ? String(fact.source).slice(0, 60) : 'agent',
          owner: fact.owner ? String(fact.owner).slice(0, 20) : 'agent',
          createdAt: Number(fact.createdAt) || this.now().getTime(),
          validFrom: Number(fact.validFrom) || Number(fact.createdAt) || this.now().getTime(),
          validUntil: fact.validUntil === null || fact.validUntil === undefined ? null : Number(fact.validUntil),
          status: ['active', 'superseded', 'expired'].includes(fact.status) ? fact.status : 'active',
          supersedes: fact.supersedes ?? null,
          supersededBy: fact.supersededBy ?? null,
        }))
    } else {
      this.logger?.warn('memory file has unknown version, quarantined', { version: payload?.version })
      await quarantineCorrupt(this.file, { logger: this.logger })
      return this
    }
    this.expire()
    this.logger?.info('memory loaded', { active: this.size, history: this.facts.length })
    return this
  }

  /** Persist the current list. */
  async save() {
    const payload = { version: 2, facts: this.facts }
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await writeAtomic(this.file, `${JSON.stringify(payload, null, 1)}\n`)
  }

  /** Mark temporary facts whose time has passed. */
  expire(now = this.now().getTime()) {
    let changed = false
    for (const fact of this.facts) {
      if (fact.status === 'active' && fact.validUntil && fact.validUntil <= now) {
        fact.status = 'expired'
        changed = true
      }
    }
    return changed
  }

  /** Убрать контекст задач старше срока хранения. */
  async cleanupTasks(days = 7, now = this.now().getTime()) {
    if (!(days > 0)) return 0
    const cutoff = now - days * 24 * 3600 * 1000
    const before = this.facts.length
    this.facts = this.facts.filter((fact) => !(fact.kind === 'task' && (fact.createdAt ?? 0) < cutoff))
    const removed = before - this.facts.length
    if (removed > 0) await this.save()
    return removed
  }

  /** How many current facts are kept. */
  get size() {
    const now = this.now().getTime()
    return this.facts.filter((fact) => isCurrent(fact, now)).length
  }

  /** Every current fact, oldest first (historic ones are in history). */
  list() {
    const now = this.now().getTime()
    return this.facts.filter((fact) => isCurrent(fact, now)).map((fact) => ({ ...fact }))
  }

  /** Replaced/expired facts, optionally for one subject. */
  history(subject) {
    const now = this.now().getTime()
    return this.facts
      .filter((fact) => fact.status !== 'active')
      .filter((fact) => (subject === undefined ? true : normalise(fact.subject ?? '') === normalise(subject)))
      .map((fact) => ({ ...fact }))
  }

  /**
   * Add or replace one fact.
   *
   * @param {string} text - the fact.
   * @param {object} [options] - `source`, `subject`, `kind`, `scope`, `validUntil`,
   *   `owner`, `now`.
   * @returns {Promise<object|undefined>} the stored fact, or undefined for a duplicate/empty line.
   */
  async add(text, { source, subject, kind = 'preference', scope, validUntil, owner = 'agent', now = () => new Date() } = {}) {
    const value = clean(text)
    if (value === '' || normalise(value).length < 3) return undefined
    if (containsSecret(value)) {
      this.logger?.warn('memory fact rejected: looks like a secret', { source })
      return undefined
    }
    const at = now().getTime()
    const scopeValue = scope && typeof scope === 'object'
      ? { type: String(scope.type ?? 'global'), value: scope.value ?? null }
      : { type: kind === 'task' ? 'task' : 'global', value: null }
    const key = normalise(value)
    const duplicate = this.facts.find((fact) => fact.status === 'active' && normalise(fact.text) === key
      && (!subject || normalise(fact.subject ?? '') === normalise(subject)))
    if (duplicate) return undefined

    const previous = subject
      ? this.facts.find((fact) => fact.status === 'active' && normalise(fact.subject ?? '') === normalise(subject)
        && fact.scope?.type === scopeValue.type && String(fact.scope?.value ?? '') === String(scopeValue.value ?? ''))
      : undefined
    if (previous) {
      previous.status = 'superseded'
    }
    const fact = {
      id: `f${at.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
      text: value,
      kind,
      subject: subject ? String(subject).slice(0, 60) : undefined,
      scope: scopeValue,
      source: source ? String(source).slice(0, 60) : 'agent',
      owner,
      createdAt: at,
      validFrom: at,
      validUntil: validUntil === undefined || validUntil === null ? null : Number(validUntil),
      status: validUntil !== undefined && validUntil !== null && Number(validUntil) <= at ? 'expired' : 'active',
      supersedes: previous?.id ?? null,
      supersededBy: null,
    }
    if (previous) previous.supersededBy = fact.id
    this.facts.push(fact)
    this.trim(now)
    await this.save()
    return fact
  }

  /** Explicit replacement of a fact by subject (alias of add with subject). */
  async set({ subject, text, scope, kind = 'preference', source = 'owner', validUntil, owner = 'owner' } = {}) {
    if (!subject) throw new Error('subject обязателен')
    return this.add(text, { source, subject, kind, scope, validUntil, owner })
  }

  /** Drop oldest facts so active and historic lists stay bounded. */
  trim(now = this.now().getTime()) {
    const active = this.facts.filter((fact) => fact.status === 'active')
    if (active.length > this.maxFacts) {
      const drop = new Set(active.sort((a, b) => a.createdAt - b.createdAt).slice(0, active.length - this.maxFacts).map((fact) => fact.id))
      this.facts = this.facts.filter((fact) => !drop.has(fact.id))
    }
    const historic = this.facts.filter((fact) => fact.status !== 'active')
    if (historic.length > this.historyMax) {
      const drop = new Set(historic.sort((a, b) => a.createdAt - b.createdAt).slice(0, historic.length - this.historyMax).map((fact) => fact.id))
      this.facts = this.facts.filter((fact) => !drop.has(fact.id))
    }
  }

  /**
   * Forget one current fact by number (1-based, as `/memory` prints it), id or substring.
   *
   * @param {string} reference - number, id or text fragment.
   * @returns {Promise<object|undefined>} the removed fact.
   */
  async forget(reference) {
    const value = String(reference ?? '').trim()
    if (value === '') return undefined
    const current = this.list()
    let target
    if (/^\d+$/.test(value)) {
      target = current[Number(value) - 1]
    } else {
      target = current.find((fact) => fact.id === value)
      if (!target) target = current.find((fact) => normalise(fact.text).includes(normalise(value)))
    }
    if (!target) return undefined
    this.facts = this.facts.filter((fact) => fact.id !== target.id)
    await this.save()
    return target
  }

  /** Forget everything. */
  async clear() {
    const count = this.size
    this.facts = []
    await this.save()
    return count
  }

  /**
   * The block injected into prompts: current facts, newest last, bounded in size.
   *
   * @param {number} [maxChars] - cap.
   * @returns {string} the facts, or an empty string when there are none.
   */
  render(maxChars = MAX_RENDER_CHARS) {
    return this.#renderFacts(this.list(), maxChars)
  }

  /**
   * Facts selected for one task: current, appropriate scope, relevant, budgeted.
   *
   * @param {object} input - `text`, `scope` ({type,value}), `budget`.
   * @returns {string} prompt block.
   */
  renderForTask({ text = '', scope, budget = 1500 } = {}) {
    const now = this.now().getTime()
    const words = normalise(text).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4)
    const current = this.facts.filter((fact) => isCurrent(fact, now))
    const applicable = current.filter((fact) => {
      const type = fact.scope?.type ?? 'global'
      if (type === 'global') return true
      if (type === 'chat') return scope?.type === 'chat' && String(fact.scope?.value) === String(scope?.value)
      if (type === 'task') return scope?.type === 'task' && String(fact.scope?.value) === String(scope?.value)
      return false
    })
    const selected = applicable
      .filter((fact) => fact.kind !== 'task' || (scope?.type === 'task' && String(fact.scope?.value) === String(scope?.value)))
      // Общие предпочтения важны всегда; остальные факты — по совпадению слов.
      .filter((fact) => (fact.kind === 'preference' && fact.scope?.type === 'global') || relevant(fact, words))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    return this.#renderFacts(selected, budget)
  }

  /** Render facts as `- text`, redacting anything secret-looking. */
  #renderFacts(facts, maxChars) {
    if (!(maxChars > 0) || facts.length === 0) return ''
    const lines = []
    let used = 0
    for (const fact of facts) {
      const line = `- ${redactSecrets(fact.text)}`
      if (used + line.length + 1 > maxChars) break
      lines.push(line)
      used += line.length + 1
    }
    return lines.join('\n')
  }

  /**
   * Read facts out of a `memory.md` written by the agent.
   *
   * @param {string} content - file contents.
   * @returns {Array<{text: string, subject?: string}>} candidate facts, in file order.
   */
  static parse(content) {
    return MemoryStore.parseFacts(content).map((fact) => fact.text)
  }

  /** Parse facts with optional subjects (used by ingest). */
  static parseFacts(content) {
    const facts = []
    for (const line of String(content ?? '').split('\n')) {
      const match = line.match(FACT_LINE)
      if (!match?.groups?.text) continue
      const subject = match.groups.subject ?? match.groups.subject2
      facts.push({ text: match.groups.text, ...(subject ? { subject: subject.trim() } : {}) })
    }
    return facts
  }

  /**
   * Ingest facts the agent wrote during a run.
   *
   * @param {string} content - contents of `memory.md`.
   * @param {object} [options] - `source`, `now`, `limit`.
   * @returns {Promise<string[]>} the facts actually added.
   */
  async ingest(content, { source = 'agent', now, limit = 20 } = {}) {
    const added = []
    for (const candidate of MemoryStore.parseFacts(content).slice(0, limit)) {
      const fact = await this.add(candidate.text, { source, subject: candidate.subject, now })
      if (fact) added.push(fact.text)
    }
    return added
  }
}

/** The file the agent may write durable facts to, inside the workspace. */
export const MEMORY_FILE = 'memory.md'

export const createMemoryStore = (options) => new MemoryStore(options)
