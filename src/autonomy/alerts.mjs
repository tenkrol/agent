/**
 * Этап 1 «Алерты»: агент сам просыпается и сообщает, что что-то не так.
 *
 * Никакой модели здесь нет: триггеры — это чистая функция от замера и базовой
 * линии, поэтому пробуждение стоит ноль токенов (спека ограничивает этап 1
 * бюджетом, но с нашей поправкой о сборке без модели он просто не расходуется).
 *
 * Что важно по спеке и учтено в коде:
 *   • дедуп: одна аномалия — одно сообщение, повтор не раньше N минут и только
 *     если метрика реально изменилась;
 *   • тихие часы: предупреждения копятся и уходят утренней сводкой, аварийные
 *     пороги (диск, сервис) пробивают тишину;
 *   • «стоп» — постоянный режим «только алерты», переживает перезапуск;
 *   • залповый рост свободного места — отдельный триггер: процентный порог его
 *     проспит (живой урок: 590 МБ за 14 минут при спокойных 40 МБ за 16 часов);
 *   • алерты не включаются, пока нет базовой линии — это условие перехода
 *     этапа 0, и оно проверяется самим кодом, а не человеком.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { baseline, READY_DAYS, readiness } from './observe.mjs'

/** Политика по умолчанию: то, что спека называет «черновиком порогов». */
export const DEFAULT_POLICY = {
  emergencyDiskMb: 300,
  warnDiskMb: 1024,
  dedupMinutes: 60,
  // Пока метрика не изменилась хотя бы на эту долю, повтор не отправляется.
  changeRatio: 0.1,
  quietHours: '23:00-07:30',
  errorsPerInterval: 20,
  localErrorBytes: 0,
}

/** Разбор «23:00-07:30» в минуты суток; пустая строка или off — тишины нет. */
export function parseQuietHours(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === '' || text === 'off' || text === 'none') return undefined
  const match = text.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
  if (!match) return undefined
  const start = Number(match[1]) * 60 + Number(match[2])
  const end = Number(match[3]) * 60 + Number(match[4])
  if (start === end) return undefined
  return { start, end, text }
}

/** Минуты суток в заданной зоне. */
export function minutesOfDay(date, timeZone = '') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || undefined,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {})
  return Number(parts.hour) * 60 + Number(parts.minute)
}

/** Внутри ли момент тихого окна (окно может пересекать полночь). */
export function inQuietHours(minutes, quiet) {
  if (!quiet) return false
  const crossesMidnight = quiet.start > quiet.end
  return crossesMidnight
    ? (minutes >= quiet.start || minutes < quiet.end)
    : (minutes >= quiet.start && minutes < quiet.end)
}

const mb = (kb) => Math.round((kb ?? 0) / 1024)
const round = (value, digits = 1) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : undefined)

/**
 * Оценка одного замера.
 *
 * @param {object} request - `sample`, `previous`, `base` (baseline), `policy`, `baselineReady`.
 * @returns {Array<object>} сработавшие триггеры.
 */
export function evaluateTriggers({ sample, previous, base, policy = DEFAULT_POLICY, baselineReady = false } = {}) {
  const triggers = []
  const push = (trigger) => triggers.push(trigger)

  // Сервис лежит — авария, тишина и «стоп» её не глушат.
  const state = sample?.service?.state
  if (state && state !== 'active') {
    push({
      id: 'service',
      severity: 'critical',
      title: 'Сервис не работает',
      detail: `${sample.service.name ?? 'dsh-agent'}: состояние ${state}${sample.service.failed ? ' (failed)' : ''}`,
      value: state,
    })
  }

  const freeKb = sample?.disk?.freeKb
  if (Number.isFinite(freeKb)) {
    const freeMb = mb(freeKb)
    if (freeMb < policy.emergencyDiskMb) {
      push({
        id: 'diskFree',
        severity: 'critical',
        title: 'Мало места на диске',
        detail: `свободно ${freeMb} МБ, аварийный порог ${policy.emergencyDiskMb} МБ`,
        value: freeMb,
      })
    } else if (freeMb < policy.warnDiskMb) {
      push({
        id: 'diskFree',
        severity: 'warn',
        title: 'Диск заканчивается',
        detail: `свободно ${freeMb} МБ, предупредительный порог ${policy.warnDiskMb} МБ`,
        value: freeMb,
      })
    }
  }

  // Залповый рост: падение свободного места за один интервал.
  const previousFree = previous?.disk?.freeKb
  if (Number.isFinite(freeKb) && Number.isFinite(previousFree) && freeKb < previousFree) {
    const dropKb = previousFree - freeKb
    const burstLimit = Math.max(50 * 1024, (base?.burstKb?.p95 ?? 0) * 5)
    if (dropKb > burstLimit) {
      push({
        id: 'diskBurst',
        severity: 'warn',
        title: 'Свободное место падает залпом',
        detail: `минус ${mb(dropKb)} МБ за интервал (обычно не больше ${mb(burstLimit)} МБ)`,
        value: mb(dropKb),
      })
    }
  }

  // Статистические пороги — только когда базовая линия готова.
  if (baselineReady && base) {
    const diskUsed = sample?.disk?.usedPct
    const diskLimit = base.rows.diskUsedPct ? round(base.rows.diskUsedPct.p95 + 5) : undefined
    if (Number.isFinite(diskUsed) && diskLimit !== undefined && diskUsed > diskLimit) {
      push({
        id: 'diskUsed',
        severity: 'warn',
        title: 'Диск занят больше нормы',
        detail: `${diskUsed}% против порога ${diskLimit}% (медиана ${round(base.rows.diskUsedPct.p50)}%)`,
        value: diskUsed,
      })
    }

    const memUsed = sample?.mem?.usedPct
    const memLimit = base.rows.memUsedPct ? round(base.rows.memUsedPct.p95 + 5) : undefined
    if (Number.isFinite(memUsed) && memLimit !== undefined && memUsed > memLimit) {
      push({
        id: 'memUsed',
        severity: 'warn',
        title: 'Память занята больше нормы',
        detail: `${memUsed}% против порога ${memLimit}% (медиана ${round(base.rows.memUsedPct.p50)}%)`,
        value: memUsed,
      })
    }

    const load = sample?.load?.one
    const loadLimit = base.rows.loadOne
      ? Math.max(base.rows.loadOne.p95 * 1.5, sample?.load?.cpuCount ?? 1)
      : undefined
    if (Number.isFinite(load) && loadLimit !== undefined && load > loadLimit) {
      push({
        id: 'loadOne',
        severity: 'warn',
        title: 'Нагрузка выше нормы',
        detail: `load1 ${load} против порога ${round(loadLimit, 2)} (p95 ${round(base.rows.loadOne.p95, 2)}, ядер ${sample?.load?.cpuCount ?? '—'})`,
        value: load,
      })
    }
  }

  const errors = Number(sample?.service?.errors) || 0
  if (errors > policy.errorsPerInterval) {
    push({
      id: 'errors',
      severity: 'warn',
      title: 'Ошибки в журнале сервиса',
      detail: `${errors} записей уровня error за интервал`,
      value: errors,
    })
  }

  return triggers
}

/**
 * Состояние алертов: дедуп, тишина, «стоп» и отложенные предупреждения.
 *
 * Хранится в файле, потому что сервис перезапускается на каждом деплое, а
 * спека требует, чтобы «стоп» и дедуп это переживали.
 */
export class AlertState {
  constructor({ file, logger } = {}) {
    this.file = file
    this.logger = logger
    this.data = { version: 1, stopped: false, sent: {}, quiet: [], digestAt: '', counters: {} }
  }

  async load() {
    try {
      const payload = JSON.parse(await fs.readFile(this.file, 'utf8'))
      this.data = {
        version: 1,
        stopped: Boolean(payload?.stopped),
        sent: payload?.sent && typeof payload.sent === 'object' ? payload.sent : {},
        quiet: Array.isArray(payload?.quiet) ? payload.quiet.filter((item) => item && item.id) : [],
        digestAt: typeof payload?.digestAt === 'string' ? payload.digestAt : '',
        counters: payload?.counters && typeof payload.counters === 'object' ? payload.counters : {},
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn('alert state unreadable, starting clean', { error })
    }
    return this
  }

  async save() {
    const file = this.file
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    await fs.writeFile(temp, `${JSON.stringify(this.data, null, 1)}\n`, 'utf8')
    await fs.rename(temp, file)
  }

  /** Режим «только алерты»: предупреждения молчат, аварии проходят. */
  get stopped() {
    return Boolean(this.data.stopped)
  }

  async setStopped(stopped) {
    this.data.stopped = Boolean(stopped)
    await this.save()
  }

  /**
   * Можно ли отправлять триггер: дедуп по времени и по изменению метрики.
   *
   * @param {object} trigger - сработавший триггер.
   * @param {Date} now - момент.
   * @param {object} policy - политика (dedupMinutes, changeRatio).
   * @returns {{send: boolean, reason?: string}} решение.
   */
  shouldSend(trigger, now, policy = DEFAULT_POLICY) {
    const last = this.data.sent[trigger.id]
    if (!last) return { send: true }
    const elapsedMinutes = (now.getTime() - Number(last.at ?? 0)) / 60000
    if (elapsedMinutes < policy.dedupMinutes) {
      // Метрика изменилась заметно — это уже другая аномалия.
      const previous = Number(last.value)
      const current = Number(trigger.value)
      const changed = Number.isFinite(previous) && Number.isFinite(current) && previous !== 0
        && Math.abs(current - previous) / Math.abs(previous) >= policy.changeRatio
      if (!changed) return { send: false, reason: `дедуп: ${Math.round(elapsedMinutes)} мин из ${policy.dedupMinutes}` }
    }
    return { send: true }
  }

  /** Отметить факт отправки (или отложения в тишину). */
  async markSent(trigger, now, { deferred = false } = {}) {
    if (!deferred) {
      this.data.sent[trigger.id] = { at: now.getTime(), value: trigger.value ?? null, severity: trigger.severity }
      this.data.counters.sent = (Number(this.data.counters.sent) || 0) + 1
    } else {
      const without = this.data.quiet.filter((item) => item.id !== trigger.id)
      without.push({ id: trigger.id, severity: trigger.severity, title: trigger.title, detail: trigger.detail, at: now.getTime() })
      this.data.quiet = without.slice(-50)
    }
    await this.save()
  }

  /** Забрать отложенные предупреждения (для утренней сводки). */
  async takeQuiet() {
    const items = [...this.data.quiet]
    this.data.quiet = []
    if (items.length > 0) await this.save()
    return items
  }

  /** Сводка уже отправлялась в эту дату? */
  digestSentOn(dateKey) {
    return this.data.digestAt === dateKey
  }

  async markDigest(dateKey) {
    this.data.digestAt = dateKey
    await this.save()
  }

  /** Счётчики этапа 1: сколько сработало, сколько отложено, сколько подавлено. */
  async count(name, delta = 1) {
    this.data.counters[name] = (Number(this.data.counters[name]) || 0) + delta
    await this.save()
  }
}

/** Текст одного алерта. */
export function renderAlert(trigger) {
  const icon = trigger.severity === 'critical' ? '🚨' : '⚠️'
  return `${icon} ${trigger.title}\n${trigger.detail}`
}

/** Классификация ошибок внешних API: 414 — транспорт, 429 — лимиты, timeout — сеть. */
export function classifyErrors(lines = []) {
  const result = { 414: 0, 429: 0, timeout: 0, server: 0, other: 0 }
  for (const line of lines) {
    const text = String(line)
    if (text.includes('414')) result[414] += 1
    else if (text.includes('429')) result[429] += 1
    else if (/timeout|ETIMEDOUT|timed out/i.test(text)) result.timeout += 1
    else if (/\b5\d\d\b/.test(text)) result.server += 1
    else result.other += 1
  }
  return result
}

/**
 * Дневная сводка: факт с числом и временем → тренд → одна гипотеза → предложение.
 *
 * @param {object} request - `samples`, `triggers`, `quiet`, `now`, `timeZone`, `days`.
 * @returns {string} текст сводки.
 */
export function renderDigest({ samples = [], quiet = [], now = new Date(), timeZone = '', days = READY_DAYS } = {}) {
  if (samples.length === 0) return '📋 Сводка: наблюдений пока нет.'
  const base = baseline(samples)
  const ready = readiness(samples, { days })
  const last = samples.at(-1)
  const lines = ['📋 Сводка за сутки', '']

  lines.push(`Диск: ${last.disk?.usedPct}% занято (${mb(last.disk?.freeKb)} МБ свободно). `
    + `За период: медиана ${round(base.rows.diskUsedPct?.p50)}%, максимум ${round(base.rows.diskUsedPct?.max)}%.`)
  lines.push(`Память: ${last.mem?.usedPct}% (медиана ${round(base.rows.memUsedPct?.p50)}%).`)
  lines.push(`Нагрузка: load1 ${last.load?.one} (медиана ${round(base.rows.loadOne?.p50, 2)}), ядер ${base.cpuCount ?? '—'}.`)
  lines.push(`Сервис: ${last.service?.state}, перезапусков ${base.restarts ?? 0}.`)
  if (base.burstKb) lines.push(`Самое резкое падение свободного места: ${mb(base.burstKb.max)} МБ за интервал.`)

  const failed = samples.filter((sample) => sample.service?.state && sample.service.state !== 'active').length
  if (failed > 0) lines.push(`Замечание: сервис был неактивен в ${failed} замерах.`)

  if (quiet.length > 0) {
    lines.push('', `Накоплено в тихие часы (${quiet.length}):`)
    for (const item of quiet.slice(-10)) lines.push(`• ${item.title}: ${item.detail}`)
  }

  lines.push('')
  lines.push(ready.ready
    ? `Базовая линия готова (${round(ready.coveredDays, 1)} из ${days} суток, покрытие ${Math.round(ready.coverage * 100)}%), пороги активны.`
    : `Наблюдений ${round(ready.coveredDays, 1)} из ${days} суток (покрытие ${Math.round(ready.coverage * 100)}%). Пороги включатся, когда данных хватит.`)

  return lines.join('\n')
}
