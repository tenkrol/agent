import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  AlertState,
  classifyErrors,
  DEFAULT_POLICY,
  evaluateTriggers,
  inQuietHours,
  minutesOfDay,
  parseQuietHours,
  renderAlert,
  renderDigest,
} from '../src/autonomy/alerts.mjs'
import { baseline } from '../src/autonomy/observe.mjs'
import { createBotHarness } from './helpers.mjs'

const BASE = 1_760_000_000

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

/** Базовая линия на неделе замеров: диск 29%, память 20%, load около 0.1. */
const calmWeek = () => Array.from({ length: 2017 }, (_, index) => sample(BASE + index * 300, {
  disk: { totalKb: 20_000_000, usedKb: 5_800_000, freeKb: 14_200_000, usedPct: 29, mount: '/' },
  mem: { totalKb: 4_000_000, usedKb: 800_000, availableKb: 3_200_000, usedPct: 20 },
}))

test('тихие часы разбираются и учитывают переход через полночь', () => {
  const quiet = parseQuietHours('23:00-07:30')
  assert.deepEqual({ start: quiet.start, end: quiet.end }, { start: 1380, end: 450 })
  assert.equal(parseQuietHours('off'), undefined)
  assert.equal(parseQuietHours(''), undefined)
  assert.equal(inQuietHours(1400, quiet), true, '23:20 внутри')
  assert.equal(inQuietHours(400, quiet), true, '06:40 внутри')
  assert.equal(inQuietHours(700, quiet), false, '11:40 снаружи')
})

test('время считается в часовом поясе агента', () => {
  const at = new Date('2026-10-12T19:35:00Z')
  assert.equal(minutesOfDay(at, 'Europe/Moscow'), 22 * 60 + 35)
  assert.equal(minutesOfDay(at, 'UTC'), 19 * 60 + 35)
})

test('аварийные триггеры: сервис и мало места', () => {
  const failed = evaluateTriggers({ sample: sample(BASE, { service: { name: 'dsh-agent', state: 'failed', failed: true } }) })
  assert.equal(failed[0].id, 'service')
  assert.equal(failed[0].severity, 'critical')

  const critical = evaluateTriggers({ sample: sample(BASE, { disk: { freeKb: 100 * 1024, usedPct: 99 } }) })
  const disk = critical.find((item) => item.id === 'diskFree')
  assert.equal(disk.severity, 'critical')
  assert.match(disk.detail, /аварийный порог 300 МБ/)

  const warn = evaluateTriggers({ sample: sample(BASE, { disk: { freeKb: 800 * 1024, usedPct: 96 } }) })
  assert.equal(warn.find((item) => item.id === 'diskFree').severity, 'warn')
})

test('залповый рост ловится отдельно от процентов', () => {
  const previous = sample(BASE)
  // Минус 590 МБ за один интервал при спокойной базовой линии.
  const current = sample(BASE + 300, { disk: { freeKb: 5_200_000 - 590 * 1024, usedPct: 77 } })
  // Базовая линия — по истории до скачка (так же считает рантайм).
  const triggers = evaluateTriggers({ sample: current, previous, base: baseline([previous]) })
  const burst = triggers.find((item) => item.id === 'diskBurst')
  assert.ok(burst, 'триггер залпового роста сработал')
  assert.match(burst.detail, /минимум 590 МБ|минус 590 МБ/)
})

test('статистические пороги молчат, пока базовая линия не готова', () => {
  const samples = calmWeek()
  const base = baseline(samples)
  const noisy = sample(BASE + 300 * 2017, {
    disk: { totalKb: 20_000_000, usedKb: 18_000_000, freeKb: 2_000_000, usedPct: 90 },
    mem: { totalKb: 4_000_000, usedKb: 3_200_000, availableKb: 800_000, usedPct: 80 },
    load: { one: 6, five: 4, fifteen: 2, cpuCount: 2 },
  })

  const before = evaluateTriggers({ sample: noisy, base, baselineReady: false })
  assert.equal(before.some((item) => ['diskUsed', 'memUsed', 'loadOne'].includes(item.id)), false, 'без baseline статистики нет')

  const after = evaluateTriggers({ sample: noisy, base, baselineReady: true })
  const ids = after.map((item) => item.id)
  assert.ok(ids.includes('diskUsed'), 'диск выше порога')
  assert.ok(ids.includes('memUsed'), 'память выше порога')
  assert.ok(ids.includes('loadOne'), 'нагрузка выше порога')
  assert.match(after.find((item) => item.id === 'loadOne').detail, /ядер 2/)
})

test('ошибки в журнале дают предупреждение', () => {
  const triggers = evaluateTriggers({ sample: sample(BASE, { service: { name: 'dsh-agent', state: 'active', errors: 25 } }) })
  assert.equal(triggers.find((item) => item.id === 'errors').severity, 'warn')
})

test('дедуп: не чаще окна и только при реальном изменении метрики', async () => {
  const dir = await fs.mkdtemp('/tmp/alerts-test-')
  const file = path.join(dir, 'alerts.json')
  try {
    const state = await new AlertState({ file }).load()
    const trigger = { id: 'memUsed', severity: 'warn', value: 50, title: 't', detail: 'd' }
    assert.equal(state.shouldSend(trigger, new Date(BASE * 1000), DEFAULT_POLICY).send, true, 'первый раз — можно')
    await state.markSent(trigger, new Date(BASE * 1000))

    const soon = new Date((BASE + 600) * 1000)
    assert.equal(state.shouldSend(trigger, soon, DEFAULT_POLICY).send, false, 'через 10 минут при том же значении — нет')
    const changed = { ...trigger, value: 90 }
    assert.equal(state.shouldSend(changed, soon, DEFAULT_POLICY).send, true, 'метрика выросла вдвое — это другая аномалия')
    const later = new Date((BASE + 7200) * 1000)
    assert.equal(state.shouldSend(trigger, later, DEFAULT_POLICY).send, true, 'через 2 часа — снова можно')

    // Перезапуск сервиса не должен сбрасывать дедуп и «стоп».
    await state.setStopped(true)
    const reloaded = await new AlertState({ file }).load()
    assert.equal(reloaded.stopped, true, 'стоп переживает перезапуск')
    assert.ok(reloaded.data.sent.memUsed, 'история отправок сохранилась')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('отложенное в тихие часы отдаётся сводкой', async () => {
  const dir = await fs.mkdtemp('/tmp/alerts-test-')
  try {
    const state = await new AlertState({ file: path.join(dir, 'alerts.json') }).load()
    const trigger = { id: 'diskUsed', severity: 'warn', value: 80, title: 'Диск занят', detail: '80% против 34%' }
    await state.markSent(trigger, new Date(BASE * 1000), { deferred: true })
    assert.equal(state.data.quiet.length, 1)
    const taken = await state.takeQuiet()
    assert.equal(taken.length, 1)
    assert.equal(state.data.quiet.length, 0, 'сводка забирает накопленное один раз')

    assert.equal(state.digestSentOn('2026-10-12'), false)
    await state.markDigest('2026-10-12')
    assert.equal(state.digestSentOn('2026-10-12'), true)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('ошибки внешних API классифицируются по классам', () => {
  const classes = classifyErrors([
    'VK ответил 414',
    'HTTP 429 Too Many Requests',
    'request timeout after 30s',
    'Telegram ответил 500',
    'что-то другое',
  ])
  assert.deepEqual(classes, { 414: 1, 429: 1, timeout: 1, server: 1, other: 1 })
})

test('сводка содержит факт, тренд и накопленное в тишину', () => {
  const text = renderDigest({
    samples: calmWeek(),
    quiet: [{ id: 'diskUsed', title: 'Диск занят', detail: '80% против 34%' }],
    now: new Date((BASE + 2016 * 300) * 1000),
  })
  assert.match(text, /Сводка за сутки/)
  assert.match(text, /Диск: 29% занято/)
  assert.match(text, /Накоплено в тихие часы/)
  assert.match(text, /Диск занят: 80% против 34%/)
  assert.match(text, /Базовая линия готова|Наблюдений/)
})

test('текст алерта различает аварию и предупреждение', () => {
  assert.match(renderAlert({ severity: 'critical', title: 'Сервис не работает', detail: 'dsh-agent: failed' }), /^🚨/)
  assert.match(renderAlert({ severity: 'warn', title: 'Диск занят', detail: '80%' }), /^⚠️/)
})

test('команды /stop, /resume и /alerts работают с состоянием на диске', async () => {
  const env = await createBotHarness()
  try {
    const say = async (text, messageId) => {
      await env.bot.handleUpdate({
        kind: 'message', id: 1, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false },
        text, attachments: [], addressed: true, messageId,
      })
      await env.bot.worker
      return env.platform.sent.at(-1).markdown
    }
    assert.match(await say('/stop', 50), /Автономия остановлена/)
    assert.match(await say('/alerts', 51), /Остановка: включена/)
    assert.match(await say('/resume', 52), /снова с предупреждениями/)
    assert.match(await say('/alerts', 53), /Остановка: нет/)
  } finally {
    await env.close()
  }
})
