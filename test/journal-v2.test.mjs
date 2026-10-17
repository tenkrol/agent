/**
 * Журнал задач версии 2: состояния, переходы, долговечная очередь и миграция.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  LEGACY_STATUS,
  STATUS,
  TaskJournal,
  describeTask,
  statusLabel,
} from '../src/storage/tasks.mjs'
import { ActionLog } from '../src/storage/actions.mjs'
import { cleanup, createTestLogger, tempDir } from './helpers.mjs'

const journalFor = (dir, maxEntries = 50) => new TaskJournal({
  file: path.join(dir, 'tasks.jsonl'),
  logger: createTestLogger(),
  maxEntries,
})

test('legacy statuses migrate to states with reasons', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'tasks.jsonl')
    await fs.writeFile(file, [
      JSON.stringify({ version: 1, id: 'a', status: 'awaiting_reply', createdAt: 1 }),
      JSON.stringify({ version: 1, id: 'b', status: 'timeout', createdAt: 2 }),
      JSON.stringify({ version: 1, id: 'c', status: 'expired', createdAt: 3 }),
      JSON.stringify({ version: 1, id: 'd', status: 'running', createdAt: 4 }),
    ].join('\n'))
    const journal = await journalFor(dir).load()
    assert.deepEqual(LEGACY_STATUS.awaiting_reply, { status: STATUS.awaiting_owner })
    assert.equal(journal.get('a').status, STATUS.awaiting_owner)
    assert.equal(journal.get('b').status, STATUS.failed)
    assert.equal(journal.get('b').reason, 'timeout')
    assert.equal(journal.get('c').status, STATUS.cancelled)
    assert.equal(journal.get('c').reason, 'expired')
    assert.equal(journal.get('d').status, STATUS.running)
    // Подписи прежних исходов сохраняются через reason.
    assert.match(statusLabel(journal.get('b')), /по таймауту/)
    assert.match(statusLabel(journal.get('c')), /ответа не дождалась/)
    assert.match(describeTask(journal.get('b')), /по таймауту/)
  } finally {
    await cleanup(dir)
  }
})

test('acceptance writes a queued task durably and queues it in order', async () => {
  const dir = await tempDir()
  try {
    const journal = await journalFor(dir).load()
    const first = await journal.openQueued({ id: 'q1', chatId: 42, userId: 7, text: 'первая' })
    const second = await journal.openQueued({ id: 'q2', chatId: 42, userId: 7, text: 'вторая' })
    assert.equal(first.duplicate, false)
    assert.equal(second.duplicate, false)
    assert.deepEqual(journal.pending().map((record) => record.id), ['q1', 'q2'])

    const reloaded = await journalFor(dir).load()
    assert.deepEqual(reloaded.pending().map((record) => record.id), ['q1', 'q2'])
    assert.equal(reloaded.get('q1').status, STATUS.queued)
  } finally {
    await cleanup(dir)
  }
})

test('the request key dedupes and conflicts instead of creating a second task', async () => {
  const dir = await tempDir()
  try {
    const journal = await journalFor(dir).load()
    const first = await journal.openQueued({ id: 'q1', chatId: 42, text: 'сделай отчёт', requestKey: 'bot:1' })
    const again = await journal.openQueued({ id: 'q2', chatId: 42, text: 'сделай отчёт', requestKey: 'bot:1' })
    assert.equal(first.duplicate, false)
    assert.equal(again.duplicate, true)
    assert.equal(again.conflict, false)
    assert.equal(again.record.id, 'q1')
    assert.equal(journal.records.size, 1)

    const conflict = await journal.openQueued({ id: 'q3', chatId: 42, text: 'другой текст', requestKey: 'bot:1' })
    assert.equal(conflict.duplicate, true)
    assert.equal(conflict.conflict, true)
    assert.equal(journal.records.size, 1)

    // Ключ переживает перезапуск.
    const reloaded = await journalFor(dir).load()
    assert.equal(reloaded.findByRequestKey('bot:1').id, 'q1')
  } finally {
    await cleanup(dir)
  }
})

test('transitions record time and reason, and invalid ones are rejected', async () => {
  const dir = await tempDir()
  try {
    const journal = await journalFor(dir).load()
    await journal.openQueued({ id: 'q1', chatId: 42, text: 'задача' })
    await journal.transition('q1', STATUS.running, { reason: 'запуск', actor: 'core' })
    await journal.transition('q1', STATUS.done, { reason: 'успех' })
    const record = journal.get('q1')
    assert.equal(record.status, STATUS.done)
    assert.deepEqual(record.transitions.map((entry) => entry.to), [STATUS.queued, STATUS.running, STATUS.done])
    for (const entry of record.transitions) {
      assert.ok(entry.at > 0)
      assert.equal(typeof entry.reason, 'string')
    }
    await assert.rejects(() => journal.transition('q1', STATUS.running, { reason: 'назад' }), /недопустим/)
  } finally {
    await cleanup(dir)
  }
})

test('answers requeue the same task and keep its order position at the end', async () => {
  const dir = await tempDir()
  try {
    const journal = await journalFor(dir).load()
    await journal.openQueued({ id: 'q1', chatId: 42, text: 'первая' })
    await journal.transition('q1', STATUS.running, { reason: 'запуск' })
    await journal.transition('q1', STATUS.awaiting_owner, { reason: 'question' })
    await journal.openQueued({ id: 'q2', chatId: 42, text: 'вторая' })
    await journal.requeue('q1', { reason: 'ответ владельца', patch: { text: 'ответ' } })
    assert.deepEqual(journal.pending().map((record) => record.id), ['q2', 'q1'])
    assert.equal(journal.get('q1').status, STATUS.queued)
    assert.equal(journal.get('q1').text, 'ответ')
  } finally {
    await cleanup(dir)
  }
})

test('recovery turns unfinished runs into interrupted, leaving queued tasks alone', async () => {
  const dir = await tempDir()
  try {
    const journal = await journalFor(dir).load()
    await journal.openQueued({ id: 'q1', chatId: 42, text: 'в очереди' })
    await journal.open({ id: 'r1', chatId: 42, brief: 'выполняется' })
    const interrupted = await journal.recover()
    assert.deepEqual(interrupted.map((record) => record.id), ['r1'])
    assert.equal(journal.get('r1').status, STATUS.interrupted)
    assert.equal(journal.get('q1').status, STATUS.queued)

    // Повторное восстановление не трогает уже помеченную задачу.
    const second = await journal.recover()
    assert.equal(second.length, 0)
  } finally {
    await cleanup(dir)
  }
})

test('the action log tracks started, confirmed and unknown outcomes', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'actions.jsonl')
    const log = await new ActionLog({ file, logger: createTestLogger() }).load()
    const confirmed = await log.begin({ taskId: 't1', kind: 'mirror', target: 'outbox' })
    await log.confirm(confirmed.id, { receipt: 200 })
    const lost = await log.begin({ taskId: 't1', kind: 'file', target: 'отчёт.docx' })
    assert.deepEqual(log.unresolved('t1').map((record) => record.id), [lost.id])

    // Перезапуск: «начато» без подтверждения становится «неизвестно».
    const reloaded = await new ActionLog({ file, logger: createTestLogger() }).load()
    const marked = await reloaded.recover()
    assert.equal(marked, 1)
    assert.equal(reloaded.unresolved('t1')[0].status, 'unknown')
    assert.equal(reloaded.all('t1').length, 2)
  } finally {
    await cleanup(dir)
  }
})
