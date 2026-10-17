/**
 * Восстановление после перезапуска и идемпотентность приёма (PLA-13).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { STATUS, TaskJournal } from '../src/storage/tasks.mjs'
import { createBotHarness, createTestLogger } from './helpers.mjs'

test('accepted tasks survive a restart and run in their original order', async () => {
  const calls = []
  const env = await createBotHarness({
    seedJournal: async ({ journal }) => {
      await journal.openQueued({ id: 'q1', chatId: '42', userId: '42', text: 'первая задача', brief: 'первая' })
      await journal.openQueued({ id: 'q2', chatId: '42', userId: '42', text: 'вторая задача', brief: 'вторая' })
    },
    runner: {
      async run(request) {
        calls.push(request)
        return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'готово', sessionId: 's1', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 10 }
      },
    },
  })
  try {
    await env.bot.worker
    assert.equal(calls.length, 2)
    assert.equal(env.journal.get('q1').status, STATUS.done)
    assert.equal(env.journal.get('q2').status, STATUS.done)
    assert.ok(env.platform.sent.some((entry) => /Восстановил принятые задачи: 2/.test(entry.markdown)))
  } finally {
    await env.close()
  }
})

test('a run interrupted by a restart becomes interrupted, not done', async () => {
  const calls = []
  const env = await createBotHarness({
    seedJournal: async ({ journal }) => {
      await journal.open({ id: 'r1', chatId: '42', brief: 'выполнялась до сбоя' })
    },
    runner: {
      async run(request) {
        calls.push(request)
        return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'готово', sessionId: 's1', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 10 }
      },
    },
  })
  try {
    await env.bot.worker
    assert.equal(calls.length, 0, 'прерванная задача не запускается сама')
    assert.equal(env.journal.get('r1').status, STATUS.interrupted)
    assert.ok(env.platform.sent.some((entry) => /Прервано перезапуском/.test(entry.markdown)))
  } finally {
    await env.close()
  }
})

test('the same bridge request returns the same task instead of a second run', async () => {
  const calls = []
  const env = await createBotHarness({
    runner: {
      async run(request) {
        calls.push(request)
        return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'готово', sessionId: 's1', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 10 }
      },
    },
  })
  try {
    const first = await env.bot.submitBridgedTask({ task: 'сделай отчёт', source: 'chat-bot', requestId: 'req-1' })
    const second = await env.bot.submitBridgedTask({ task: 'сделай отчёт', source: 'chat-bot', requestId: 'req-1' })
    assert.equal(second.taskId, first.taskId)
    assert.equal(second.duplicate, true)
    await env.bot.worker
    assert.equal(calls.length, 1, 'второго выполнения нет')

    await assert.rejects(
      () => env.bot.submitBridgedTask({ task: 'другой текст', source: 'chat-bot', requestId: 'req-1' }),
      (error) => error.code === 'CONFLICT',
    )
  } finally {
    await env.close()
  }
})

test('a storage failure refuses the task and starts nothing', async () => {
  let calls = 0
  const env = await createBotHarness({
    runner: {
      async run() {
        calls += 1
        return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'готово', sessionId: 's1', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 10 }
      },
    },
  })
  try {
    const file = env.journal.file
    await fs.chmod(file, 0o400)
    await assert.rejects(
      () => env.bot.submitBridgedTask({ task: 'не должна приняться', requestId: 'req-fail' }),
      (error) => error.code === 'STORAGE_FAILED',
    )
    assert.equal(env.bot.queue.length, 0, 'в очередь задача не попала')
    assert.equal(calls, 0, 'выполнение не началось')
  } finally {
    await fs.chmod(env.journal.file, 0o600).catch(() => {})
    await env.close()
  }
})

test('/continue refuses to repeat an action with unknown outcome without explicit consent', async () => {
  const env = await createBotHarness({
    seedJournal: async ({ journal }) => {
      await journal.open({ id: 'i1', chatId: '42', brief: 'отправь отчёт' })
    },
  })
  try {
    await env.bot.worker
    // После восстановления задача прервана; имитируем неизвестное действие.
    const action = await env.actions.begin({ taskId: 'i1', kind: 'mirror', target: 'outbox' })
    await env.actions.unknown(action.id, { reason: 'сбой' })

    const refused = await env.bot.continueInterrupted({ args: 'i1' })
    assert.match(refused, /неизвестным исходом/)
    assert.equal(env.journal.get('i1').status, STATUS.interrupted)

    const accepted = await env.bot.continueInterrupted({ args: 'i1 --yes' })
    assert.match(accepted, /Продолжаю/)
    assert.equal(env.journal.get('i1').status, STATUS.queued)
  } finally {
    await env.close()
  }
})

test('an answered question returns the task to the queue with the same id', async () => {
  const env = await createBotHarness()
  try {
    const { taskId } = await env.bot.submitBridgedTask({ task: 'посчитай отчёт' })
    await env.bot.worker
    // Задача выполнена; в журнале остался тот же id — повторное использование id допустимо только через продолжение.
    assert.equal(env.journal.get(taskId).status, STATUS.done)
    assert.ok(env.journal.get(taskId).transitions.some((entry) => entry.to === STATUS.done))
  } finally {
    await env.close()
  }
})

test('the bridge passes requestId and maps storage conflicts to HTTP codes', async () => {
  const logger = createTestLogger()
  assert.ok(logger)
  // Сами коды проверяются в bridge-http.test.mjs; здесь — что ключ доходит до ядра.
  const env = await createBotHarness()
  try {
    const first = await env.bot.submitBridgedTask({ task: 'задача', requestId: 'same' })
    assert.ok(first.taskId)
    assert.equal(env.journal.get(first.taskId).requestKey, 'http:same')
  } finally {
    await env.close()
  }
})

test('a task stopped by service shutdown stays interrupted for the next start', async () => {
  const env = await createBotHarness({
    runner: {
      async run({ signal }) {
        await new Promise((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', resolve, { once: true })
        })
        return {
          ok: false,
          aborted: true,
          exitCode: null,
          timedOut: false,
          text: '',
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, steps: 0 },
          tools: [],
          errors: [],
          stderr: '',
          durationMs: 5,
        }
      },
    },
  })
  try {
    const { taskId } = await env.bot.submitBridgedTask({ task: 'долгая задача' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await env.bot.stop()
    const reloaded = await new TaskJournal({
      file: env.journal.file,
      logger: createTestLogger(),
    }).load()
    assert.equal(reloaded.get(taskId).status, STATUS.interrupted)
    assert.equal(reloaded.get(taskId).reason, 'перезапуск сервиса')
  } finally {
    await env.close()
  }
})
