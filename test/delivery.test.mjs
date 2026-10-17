import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildBody,
  buildBriefNotes,
  buildDiagnostics,
  buildExpensiveNote,
  buildFooter,
  buildHeader,
  composeReportText,
  quickFooter,
  quickStatus,
  statusMarkdown,
} from '../src/delivery/index.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// ru-RU форматирует числа с неразрывным пробелом — в ожиданиях сравниваем с обычным.
const norm = (text) => String(text).replace(/\u00a0/g, ' ')
const LIMITS = { taskMaxSteps: 16, taskTokenBudget: 1_500_000, taskTimeoutMs: 1_200_000, taskTokenWarn: 300_000 }
const usage = { steps: 3, totalTokens: 25_000 }
const ok = (over = {}) => ({ ok: true, text: 'Готово', usage, durationMs: 120_000, ...over })

test('заголовки: отмена, шаги, бюджет, таймаут, код ошибки', () => {
  assert.match(buildHeader({ result: ok({ aborted: true }), limits: LIMITS }), /отменена/)
  assert.match(buildHeader({ result: ok({ stepsExceeded: true }), limits: LIMITS }), /превысила 16 шагов/)
  assert.match(norm(buildHeader({ result: ok({ budgetExceeded: true }), limits: LIMITS })), /1 500 000 токенов/)
  assert.match(buildHeader({ result: ok({ timedOut: true }), limits: LIMITS }), /лимит времени \(20 мин\)/)
  assert.match(buildHeader({ result: ok({ ok: false, exitCode: 2 }), limits: LIMITS }), /кодом 2/)
  assert.equal(buildHeader({ result: ok(), limits: LIMITS }), '')
})

test('тело: пустой ответ, обрезка с пометкой', () => {
  assert.equal(buildBody({ result: ok({ text: '' }), maxAnswerChars: 100 }), 'Агент не вернул текст ответа.')
  assert.equal(buildBody({ result: ok({ text: '', aborted: true }), maxAnswerChars: 100 }), '')
  const long = 'я'.repeat(120)
  assert.equal(buildBody({ result: ok({ text: long }), maxAnswerChars: 100 }), `${'я'.repeat(100)}\n\n[…ответ обрезан]`)
})

test('диагностика только для неудачи', () => {
  assert.equal(buildDiagnostics({ result: ok() }), '')
  assert.match(buildDiagnostics({ result: ok({ ok: false, stderr: 'boom' }) }), /Диагностика[\s\S]*boom/)
})

test('подпись и предупреждение о дорогой задаче', () => {
  assert.equal(norm(buildFooter({ minutes: 2, steps: 3, tokens: 25_000, usdText: '$0.001' })),
    '\n_2 мин, шагов 3, токенов 25 000, ≈$0.001._')
  assert.equal(buildExpensiveNote({ tokens: 25_000, steps: 3, usdText: '$0.001', warnAt: 300_000 }), '')
  assert.match(buildExpensiveNote({ tokens: 400_000, steps: 9, usdText: '$0.01', warnAt: 300_000 }), /Дорогая задача/)
})

test('brief-заметки: проблема вложения и пути архива', () => {
  assert.deepEqual(buildBriefNotes({ reportStyle: 'verbose', issue: 'x', taskId: '1', diskPaths: ['/a'] }), [])
  assert.deepEqual(buildBriefNotes({ reportStyle: 'brief', issue: 'файл не прочитан', taskId: '42', diskPaths: [] }),
    ['файл не прочитан'])
  assert.deepEqual(buildBriefNotes({ reportStyle: 'brief', taskId: '42', diskPaths: ['/Агент/42/a.docx'] }),
    ['📁 Файлы задачи 42 лежат на Яндекс.Диске: /Агент/42/a.docx'])
})

test('полный текст ответа: порядок частей и пустые не попадают', () => {
  const text = composeReportText({
    result: ok({ text: 'Готово' }),
    job: { id: '7', issue: '' },
    limits: LIMITS,
    reportStyle: 'brief',
    maxAnswerChars: 4000,
    usdText: '$0.001',
    diskPaths: ['/Агент/7/a.txt'],
    footer: { minutes: 2, steps: 3, tokens: 25_000, usdText: '$0.001' },
  })
  const parts = text.split('\n\n')
  assert.equal(parts[0], 'Готово')
  assert.match(norm(parts[1]), /2 мин, шагов 3/)
  assert.match(parts[2], /Файлы задачи 7/)
})

test('отменённая задача: без подписи и без предупреждения о деньгах', () => {
  const text = composeReportText({
    result: ok({ aborted: true, text: 'частично' }),
    job: { id: '8' },
    limits: LIMITS,
    reportStyle: 'brief',
    maxAnswerChars: 4000,
    usdText: '$0.001',
    footer: undefined,
  })
  assert.match(text, /отменена/)
  assert.equal(text.includes('мин, шагов'), false)
  assert.equal(text.includes('Дорогая задача'), false)
})

test('строка статуса', () => {
  assert.equal(statusMarkdown({ result: ok(), taskId: '9' }), '✅ Задача 9 выполнена.')
  assert.match(statusMarkdown({ result: ok({ aborted: true }), taskId: '9', limits: LIMITS }), /отменена/)
  assert.match(statusMarkdown({ result: ok({ timedOut: true }), taskId: '9', limits: LIMITS }), /лимит времени/)
})

test('быстрый ответ: подпись и статус', () => {
  assert.match(quickFooter({ tokens: 212, usdText: '$0.0001', taskId: '10' }), /ответил сразу[\s\S]*212 токенов[\s\S]*\/retry 10/)
  assert.equal(quickStatus({ taskId: '10' }), '✅ Ответил сразу (10).')
})

test('домен не импортирует другие домены', async () => {
  const dir = path.join(root, 'src', 'delivery')
  const offenders = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith('.mjs')) continue
    const text = await fs.readFile(path.join(dir, entry.name), 'utf8')
    if (/from '\.\.\/(?!\.)/.test(text)) offenders.push(entry.name)
  }
  assert.deepEqual(offenders, [], `внешние импорты в delivery: ${offenders.join(', ')}`)
})
