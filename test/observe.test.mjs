import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  baseline,
  loadObservations,
  OBSERVATIONS_FILE,
  parseObservations,
  quantile,
  readiness,
  renderReport,
  series,
  suggestThresholds,
} from '../src/autonomy/observe.mjs'
import { createBotHarness } from './helpers.mjs'

const BASE = 1_760_000_000

/** Один замер с разумными значениями; поля можно переопределить. */
const sample = (epoch, over = {}) => ({
  ts: new Date(epoch * 1000).toISOString(),
  epoch,
  disk: { totalKb: 20_000_000, usedKb: 14_800_000, freeKb: 5_200_000, usedPct: 74, mount: '/' },
  mem: { totalKb: 4_000_000, usedKb: 1_480_000, availableKb: 2_520_000, usedPct: 37 },
  load: { one: 0.12, five: 0.1, fifteen: 0.08, cpuCount: 2 },
  uptimeSec: 300_000,
  service: { name: 'dsh-agent', state: 'active', failed: false, restarts: 0 },
  ...over,
})

/** Неделя замеров с шагом 5 минут. */
const week = () => Array.from({ length: 2017 }, (_, index) => sample(BASE + index * 300))

test('журнал разбирается построчно, битые строки не ломают разбор', () => {
  const text = [
    JSON.stringify(sample(BASE + 300)),
    '',
    'не json',
    '{"epoch":', // обрезанная строка после падения
    JSON.stringify(sample(BASE)),
  ].join('\n')
  const parsed = parseObservations(text)
  assert.equal(parsed.length, 2)
  assert.deepEqual(parsed.map((item) => item.epoch), [BASE, BASE + 300], 'отсортировано по времени')
})

test('квантили и сводка считаются по-человечески', () => {
  const sorted = [1, 2, 3, 4, 5]
  assert.equal(quantile(sorted, 0.5), 3)
  assert.equal(quantile(sorted, 0), 1)
  assert.equal(quantile(sorted, 1), 5)
  const row = series([5, 1, 3, 2, 4])
  assert.deepEqual({ min: row.min, p50: row.p50, max: row.max, count: row.count }, { min: 1, p50: 3, max: 5, count: 5 })
  assert.equal(series([]), undefined)
  assert.equal(series([Number.NaN, undefined, 2]).count, 1)
})

test('базовая линия: норма, скачки и состояния сервиса', () => {
  const samples = [
    sample(BASE, {}),
    sample(BASE + 300, { disk: { totalKb: 20_000_000, usedKb: 15_000_000, freeKb: 5_000_000, usedPct: 75 } }),
    // залповый рост: минус 590 МБ за интервал (живой урок из спеки)
    sample(BASE + 600, {
      disk: { totalKb: 20_000_000, usedKb: 15_000_000 + 590 * 1024, freeKb: 5_000_000 - 590 * 1024, usedPct: 78 },
    }),
    sample(BASE + 900, { service: { name: 'dsh-agent', state: 'failed', failed: true, restarts: 2 }, load: { one: 4.2, five: 2, fifteen: 1, cpuCount: 2 } }),
  ]
  const base = baseline(samples)
  assert.equal(base.count, 4)
  assert.equal(base.rows.diskUsedPct.min, 74)
  assert.equal(base.rows.diskUsedPct.max, 78)
  assert.equal(base.burstKb.max, 590 * 1024, 'падение свободного места поймано отдельно от процентов')
  assert.deepEqual(base.serviceStates.sort(), ['active', 'failed'])
  assert.equal(base.restarts, 2)
  assert.equal(base.cpuCount, 2)
  assert.ok(base.hourly[BASE % 24] === undefined || typeof base.hourly === 'object', 'суточный профиль собран')
})

test('готовность требует и суток, и покрытия интервалов', () => {
  const short = readiness([sample(BASE), sample(BASE + 300)])
  assert.equal(short.ready, false)
  assert.ok(short.coveredDays < 1)

  const full = readiness(week())
  assert.equal(full.ready, true, `7 суток и покрытие ${full.coverage}`)
  assert.ok(full.coverage >= 0.95)
  assert.equal(full.requiredDays, 7)

  // Те же сутки, но с дырами: покрытие ниже порога — переходить нельзя.
  const sparse = week().filter((_, index) => index % 10 === 0)
  const gappy = readiness(sparse)
  assert.equal(gappy.ready, false)
  assert.ok(gappy.coverage < 0.95)
})

test('пороги выводятся из чисел и объясняют своё основание', () => {
  const thresholds = suggestThresholds(baseline(week()))
  const byMetric = Object.fromEntries(thresholds.map((item) => [item.metric, item]))
  assert.ok(byMetric.diskFreeKb, 'есть порог по свободному месту')
  assert.match(byMetric.diskFreeKb.text, /МБ/)
  assert.match(byMetric.diskFreeKb.basis, /минимум/)
  assert.ok(byMetric.loadOne, 'есть порог по нагрузке')
  assert.match(byMetric.loadOne.basis, /ядер 2/)
  assert.match(byMetric.service.text, /не active/)
  for (const item of thresholds) assert.ok(item.basis.length > 0, `${item.metric} без основания`)
})

test('отчёт для чата: пустой журнал и полный', () => {
  const empty = renderReport({ samples: [] })
  assert.match(empty, /журнал пуст/)
  assert.match(empty, /agent-metrics\.timer/)

  const report = renderReport({ samples: week(), now: new Date((BASE + 2016 * 300) * 1000) })
  assert.match(report, /Наблюдения \(этап 0\)/)
  assert.match(report, /Базовая линия/)
  assert.match(report, /Черновик порогов для этапа 1/)
  assert.match(report, /Готовность: 7 из 7 суток/)
  assert.match(report, /Алерты на этапе 0 не отправляются/)
})

test('журнал читается с диска, отсутствие файла не ошибка', async () => {
  const dir = await fs.mkdtemp('/tmp/observe-test-')
  const file = path.join(dir, OBSERVATIONS_FILE)
  assert.deepEqual(await loadObservations(file), [])
  await fs.writeFile(file, `${JSON.stringify(sample(BASE))}\n`, 'utf8')
  assert.equal((await loadObservations(file)).length, 1)
  await fs.rm(dir, { recursive: true, force: true })
})

test('команда /observe отдаёт отчёт наблюдателя', async () => {
  const env = await createBotHarness()
  try {
    const file = path.join(env.config.workspace.stateDir, OBSERVATIONS_FILE)
    await fs.writeFile(file, `${week().map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8')
    await env.bot.handleUpdate({
      kind: 'message', id: 1, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false },
      text: '/observe', attachments: [], addressed: true, messageId: 40,
    })
    await env.bot.worker
    const reply = env.platform.sent.at(-1).markdown
    assert.match(reply, /Наблюдения \(этап 0\)/)
    assert.match(reply, /Сейчас: диск 74%/)
    assert.match(reply, /Черновик порогов/)
  } finally {
    await env.close()
  }
})

test('порог «мало места» не выводится из текущего значения', () => {
  // Свободно 12 ГБ и стабильно: тревога «меньше 12 ГБ» срабатывала бы сразу.
  const thresholds = suggestThresholds(baseline(week()))
  const free = thresholds.find((item) => item.metric === 'diskFreeKb')
  assert.match(free.basis, /абсолютный порог/)
  const value = Number(free.text.match(/([\d\s]+) МБ/)[1].replace(/\s/g, ''))
  // Порог берётся от абсолютного минимума и доли наблюдённого минимума, но не от
  // текущих 12 ГБ: порог обязан быть заметно ниже того, что есть сейчас.
  assert.ok(value >= 1024, `порог ${value} МБ не должен быть ниже абсолютного гигабайта`)
  assert.ok(value < 12_822 / 2, `порог ${value} МБ должен быть ниже половины текущего запаса`)
})

test('порог нагрузки считается числом, а не строкой', () => {
  const thresholds = suggestThresholds(baseline(week()))
  const load = thresholds.find((item) => item.metric === 'loadOne')
  assert.equal(load.text.includes('NaN'), false, 'форматирование не попадает в сравнение')
  const value = Number(load.text.match(/выше ([\d.,]+)/)[1].replace(',', '.'))
  assert.ok(Number.isFinite(value) && value >= 2, `порог ${value} должен быть не ниже числа ядер`)
})

test('пока baseline не готов, пороги не показываются', () => {
  const report = renderReport({ samples: [sample(BASE), sample(BASE + 300)] })
  assert.match(report, /Пороги появятся, когда наберётся 7 суток/)
  assert.equal(report.includes('Черновик порогов'), false, 'черновик по трём замерам не выдаём')
})
