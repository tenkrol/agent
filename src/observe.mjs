/**
 * Этап 0 «Наблюдатель»: базовая линия, готовность и черновик порогов.
 *
 * Метрики снимает скрипт (`deploy/metrics-collect.sh`) — без модели, ноль
 * токенов. Этот модуль только читает журнал наблюдений и считает то, что нужно
 * для перехода на этап 1: норму по каждому показателю, покрытие интервалов и
 * пороги, выведенные из реальных чисел, а не из головы.
 *
 * На этапе 0 алерты не отправляются вообще: сначала 7 суток наблюдений без
 * пропусков и без единого изменяющего действия.
 */
import fs from 'node:fs/promises'

/** Имя журнала наблюдений в каталоге состояния. */
export const OBSERVATIONS_FILE = 'observations.jsonl'

/** Сколько суток наблюдений нужно, чтобы считать базовую линию готовой. */
export const READY_DAYS = 7
/** Ожидаемый интервал между замерами (совпадает с таймером). */
export const SAMPLE_INTERVAL_SEC = 300
/** Минимальная доля собранных интервалов для перехода. */
export const MIN_COVERAGE = 0.95
/** Абсолютный порог «мало места», МБ: срабатывает независимо от базовой линии. */
export const DISK_FLOOR_MB = 1024

/** Разбор журнала: одна строка — один замер; битые строки пропускаем. */
export function parseObservations(text) {
  const samples = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const sample = JSON.parse(trimmed)
      if (sample && typeof sample.epoch === 'number') samples.push(sample)
    } catch {
      // Обрезанная строка после падения — не повод терять весь журнал.
    }
  }
  return samples.sort((a, b) => a.epoch - b.epoch)
}

/** Чтение журнала наблюдений. */
export async function loadObservations(file) {
  try {
    return parseObservations(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return []
  }
}

/** Квантиль по отсортированному массиву (линейная интерполяция). */
export function quantile(sorted, q) {
  if (sorted.length === 0) return undefined
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/** Сводка по одному ряду чисел. */
export function series(values) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (clean.length === 0) return undefined
  const sum = clean.reduce((total, value) => total + value, 0)
  return {
    count: clean.length,
    min: clean[0],
    p05: quantile(clean, 0.05),
    p50: quantile(clean, 0.5),
    p95: quantile(clean, 0.95),
    max: clean.at(-1),
    mean: sum / clean.length,
  }
}

/** Показатели, по которым считается норма. */
const METRICS = {
  diskUsedPct: (sample) => sample.disk?.usedPct,
  diskFreeKb: (sample) => sample.disk?.freeKb,
  memUsedPct: (sample) => sample.mem?.usedPct,
  loadOne: (sample) => sample.load?.one,
  loadFive: (sample) => sample.load?.five,
}

/** Базовая линия: норма по каждому показателю плюс суточный профиль. */
export function baseline(samples) {
  const rows = {}
  for (const [name, pick] of Object.entries(METRICS)) rows[name] = series(samples.map(pick))

  const byHour = {}
  for (const sample of samples) {
    const date = new Date(sample.epoch * 1000)
    const hour = date.getUTCHours()
    const bucket = byHour[hour] ?? { diskUsedPct: [], memUsedPct: [], loadOne: [] }
    bucket.diskUsedPct.push(sample.disk?.usedPct)
    bucket.memUsedPct.push(sample.mem?.usedPct)
    bucket.loadOne.push(sample.load?.one)
    byHour[hour] = bucket
  }
  const hourly = {}
  for (const [hour, bucket] of Object.entries(byHour)) {
    hourly[hour] = {
      diskUsedPct: series(bucket.diskUsedPct)?.p50,
      memUsedPct: series(bucket.memUsedPct)?.p50,
      loadOne: series(bucket.loadOne)?.p50,
    }
  }

  // Резкие скачки — отдельный класс триггера: процентный порог залповый рост
  // свободного места проспит (живой урок: 590 МБ за 14 минут при спокойных 40 МБ
  // за 16 часов).
  const freeDrops = []
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1].disk?.freeKb
    const current = samples[index].disk?.freeKb
    if (Number.isFinite(previous) && Number.isFinite(current) && current < previous) {
      freeDrops.push(previous - current)
    }
  }
  const burst = series(freeDrops)

  const span = samples.length > 1
    ? { from: samples[0].ts, to: samples.at(-1).ts, seconds: samples.at(-1).epoch - samples[0].epoch }
    : samples.length === 1 ? { from: samples[0].ts, to: samples[0].ts, seconds: 0 } : undefined

  return {
    count: samples.length,
    span,
    cpuCount: samples.at(-1)?.load?.cpuCount,
    rows,
    hourly,
    burstKb: burst,
    serviceStates: [...new Set(samples.map((sample) => sample.service?.state).filter(Boolean))],
    restarts: samples.at(-1)?.service?.restarts,
    errors: samples.reduce((max, sample) => Math.max(max, Number(sample.service?.errors) || 0), 0),
  }
}

/**
 * Готовность этапа 0: сколько суток и какая доля интервалов собрана.
 *
 * @param {object[]} samples - наблюдения.
 * @param {object} [options] - `days`, `intervalSec`.
 */
export function readiness(samples, { days = READY_DAYS, intervalSec = SAMPLE_INTERVAL_SEC } = {}) {
  if (samples.length === 0) {
    return { samples: 0, coveredDays: 0, requiredDays: days, coverage: 0, ready: false, missing: days * (86400 / intervalSec) }
  }
  const first = samples[0].epoch
  const last = samples.at(-1).epoch
  const spanDays = Math.max(0, (last - first) / 86400)
  const expected = Math.max(1, Math.round((last - first) / intervalSec) + 1)
  const coverage = Math.min(1, samples.length / expected)
  return {
    samples: samples.length,
    coveredDays: spanDays,
    requiredDays: days,
    expected,
    coverage,
    missing: Math.max(0, Math.round(days * (86400 / intervalSec)) - samples.length),
    ready: spanDays >= days && coverage >= MIN_COVERAGE,
  }
}

const round = (value, digits = 1) => {
  if (!Number.isFinite(value)) return '—'
  return Number(value.toFixed(digits)).toLocaleString('ru-RU')
}

const mb = (kb) => `${Math.round(kb / 1024).toLocaleString('ru-RU')} МБ`

/**
 * Черновик порогов для этапа 1 — из базовой линии, с указанием основания.
 *
 * @param {object} base - результат `baseline`.
 * @returns {Array<{metric: string, text: string, basis: string}>} пороги.
 */
export function suggestThresholds(base) {
  const out = []
  const diskUsed = base.rows.diskUsedPct
  const free = base.rows.diskFreeKb
  const memUsed = base.rows.memUsedPct
  const load = base.rows.loadOne

  if (free) {
    // Порог «мало места» нельзя выводить из текущего значения: если диск сейчас
    // свободен на 12 ГБ, тревога «меньше 12 ГБ» сработает сразу. Берём абсолютный
    // минимум (по умолчанию 1 ГБ) и, если наблюдались просадки, долю от самой
    // низкой точки — что наступит позже.
    const absolute = Math.max(1, DISK_FLOOR_MB) * 1024
    const relative = (free.min ?? 0) * 0.3
    const floor = Math.max(absolute, relative)
    out.push({
      metric: 'diskFreeKb',
      text: `свободно меньше ${mb(floor)} — мало места`,
      basis: `абсолютный порог ${mb(absolute)}, минимум за период ${mb(free.min)}`,
    })
  }
  if (diskUsed) {
    const limit = Math.min(98, Math.round((diskUsed.p95 + 5) * 10) / 10)
    out.push({
      metric: 'diskUsedPct',
      text: `диск занят больше ${round(limit)}% — рост`,
      basis: `медиана ${round(diskUsed.p50)}%, p95 ${round(diskUsed.p95)}%`,
    })
  }
  if (memUsed) {
    const limit = Math.min(97, Math.round((memUsed.p95 + 5) * 10) / 10)
    out.push({
      metric: 'memUsedPct',
      text: `память занята больше ${round(limit)}% — рост`,
      basis: `медиана ${round(memUsed.p50)}%, p95 ${round(memUsed.p95)}%`,
    })
  }
  if (load) {
    // Сравниваем числа, а форматируем только для показа: раньше здесь в Math.max
    // попадала уже отформатированная строка, и порог превращался в NaN.
    const p95 = load.p95 ?? load.max
    const limit = Math.max(p95 * 1.5, base.cpuCount ?? 1)
    out.push({
      metric: 'loadOne',
      text: `load1 выше ${round(limit, 2)} — нагрузка`,
      basis: `p95 ${round(p95, 2)}, ядер ${base.cpuCount ?? '—'}`,
    })
  }
  if (base.burstKb) {
    const limit = Math.max(50 * 1024, Math.round((base.burstKb.p95 ?? base.burstKb.max) * 5) / 1)
    out.push({
      metric: 'diskBurst',
      text: `свободное место падает больше чем на ${mb(limit)} за интервал — залповый рост`,
      basis: `p95 падения за интервал ${mb(base.burstKb.p95 ?? base.burstKb.max)}`,
    })
  }
  out.push({
    metric: 'service',
    text: 'сервис dsh-agent не active или failed — авария',
    basis: `наблюдались состояния: ${base.serviceStates.join(', ') || '—'}`,
  })
  return out
}

/**
 * Текст отчёта `/observe`.
 *
 * @param {object} request - `samples`, optional `days`, `now`.
 * @returns {string} отчёт для чата.
 */
export function renderReport({ samples = [], days = READY_DAYS, now = new Date() } = {}) {
  if (samples.length === 0) {
    return [
      '🔭 Наблюдения (этап 0): журнал пуст.',
      '',
      'Замеры снимает таймер agent-metrics.timer. Проверить: `systemctl list-timers agent-metrics.timer`,',
      'а если таймер ещё не установлен — развернуть релиз (`deploy/install-remote.sh`).',
    ].join('\n')
  }

  const base = baseline(samples)
  const ready = readiness(samples, { days })
  const last = samples.at(-1)
  const parts = []
  parts.push('🔭 Наблюдения (этап 0)')
  const spanHours = base.span ? base.span.seconds / 3600 : 0
  parts.push(`Собрано: ${base.count} замеров за ${round(spanHours, 1)} ч (интервал ≈${Math.round(SAMPLE_INTERVAL_SEC / 60)} мин), покрытие ${Math.round(ready.coverage * 100)}%`)
  parts.push(ready.ready
    ? `Готовность: ${round(ready.coveredDays, 1)} из ${days} суток — базовая линия готова, можно переходить к этапу 1`
    : `Готовность: ${round(ready.coveredDays, 1)} из ${days} суток — baseline ещё не готов (нужно ${ready.missing} замеров)`)

  parts.push('')
  parts.push(`Сейчас: диск ${last.disk?.usedPct}% (${mb(last.disk?.freeKb ?? 0)} свободно), `
    + `память ${last.mem?.usedPct}%, load ${last.load?.one}/${last.load?.five}/${last.load?.fifteen}, `
    + `сервис ${last.service?.state}`)

  parts.push('')
  parts.push('Базовая линия:')
  const rows = base.rows
  if (rows.diskUsedPct) {
    parts.push(`• диск занято: ${round(rows.diskUsedPct.min)}–${round(rows.diskUsedPct.max)}% (медиана ${round(rows.diskUsedPct.p50)})`)
  }
  if (rows.diskFreeKb) {
    parts.push(`• свободно: ${mb(rows.diskFreeKb.min)} – ${mb(rows.diskFreeKb.max)} (медиана ${mb(rows.diskFreeKb.p50)})`)
  }
  if (rows.memUsedPct) {
    parts.push(`• память занято: ${round(rows.memUsedPct.min)}–${round(rows.memUsedPct.max)}% (медиана ${round(rows.memUsedPct.p50)})`)
  }
  if (rows.loadOne) {
    parts.push(`• load1: ${round(rows.loadOne.min, 2)}–${round(rows.loadOne.max, 2)} (медиана ${round(rows.loadOne.p50, 2)}), ядер ${base.cpuCount ?? '—'}`)
  }
  if (base.restarts !== undefined) parts.push(`• перезапусков сервиса: ${base.restarts}`)
  if (base.errors > 0) parts.push(`• ошибок в журнале за интервал (максимум): ${base.errors}`)

  parts.push('')
  if (ready.ready) {
    parts.push('Черновик порогов для этапа 1:')
    for (const item of suggestThresholds(base)) {
      parts.push(`• ${item.text} _(${item.basis})_`)
    }
  } else {
    // Порог, посчитанный по трём замерам, ничего не значит и опаснее его отсутствия:
    // показываем только сами значения, а пороги — после 7 суток (условие спеки).
    parts.push(`Пороги появятся, когда наберётся ${days} суток наблюдений: сейчас p95 считается по ${base.count} замерам и как основание не годится.`)
  }

  parts.push('')
  parts.push('Алерты на этапе 0 не отправляются: сначала 7 суток наблюдений без пропусков и без изменяющих действий.')
  return parts.join('\n')
}
