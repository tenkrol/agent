/**
 * Маршрут задачи по контракту v2: результат и вопрос уходят событием в исходный
 * разговор, ответ продолжает ту же задачу, ревизия использует прошлый результат,
 * файлы передаются через реестр.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STATUS } from '../src/storage/tasks.mjs'
import { createBotHarness } from './helpers.mjs'

const ROUTE = { platform: 'telegram', botId: '999', chatId: '42', messageId: 7 }

/** Фейковая точка приёма: записывает события и всегда подтверждает обработку. */
function outboxRecorder() {
  const events = []
  return {
    events,
    fetchImpl: async (url, options) => {
      const event = JSON.parse(options.body)
      events.push(event)
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, eventId: event.eventId, processed: true, duplicate: false }),
      }
    },
  }
}

test('a routed task delivers its result as one event and does not write to the personal chat', async () => {
  const outbox = outboxRecorder()
  const env = await createBotHarness({
    configEnv: { BRIDGE_ROUTE_BOT_ID: '999', BRIDGE_ROUTE_CHAT_ID: '42' },
    deliveryFetch: outbox.fetchImpl,
    runner: {
      async run() {
        return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'Готово: отчёт', sessionId: 's1', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 50 }
      },
    },
  })
  try {
    const { taskId } = await env.bot.submitV2Task({ task: 'сделай отчёт', requestId: 'req-route', route: ROUTE })
    await env.bot.worker
    assert.equal(outbox.events.length, 1)
    assert.equal(outbox.events[0].type, 'result')
    assert.equal(outbox.events[0].eventId, `${taskId}:result:1`)
    assert.equal(outbox.events[0].route.chatId, '42')
    assert.match(outbox.events[0].text, /Готово: отчёт/)
    assert.equal(outbox.events[0].title, 'Ответ агента')
    assert.equal(env.platform.sent.some((entry) => /Готово: отчёт/.test(entry.markdown)), false, 'в личный чат результата нет')
    const state = env.bot.taskState(taskId)
    assert.equal(state.execution, STATUS.done)
    assert.equal(state.delivery.state, 'acked')
    assert.equal(state.version, 1)
    assert.equal(state.rootTaskId, taskId)
  } finally {
    await env.close()
  }
})

test('a routed task keeps the caller principal separate from the alert chat', async () => {
  const outbox = outboxRecorder()
  const env = await createBotHarness({
    configEnv: {
      ALLOWED_USER_IDS: '101,202',
      ALERT_CHAT_ID: '101',
      BRIDGE_ROUTE_BOT_ID: '999',
      BRIDGE_ROUTE_CHAT_ID: '202',
    },
    deliveryFetch: outbox.fetchImpl,
  })
  try {
    const { taskId } = await env.bot.submitV2Task({
      task: 'личная задача второго пользователя',
      requestId: 'req-owner-202',
      route: { ...ROUTE, chatId: '202' },
      principal: { userId: '202', scopeId: 'personal-202' },
    })
    await env.bot.worker
    const record = env.journal.get(taskId)
    assert.equal(record.userId, '202')
    assert.equal(record.scopeId, 'personal-202')
    assert.equal(env.bot.taskState(taskId).userId, '202')
    const activity = env.bot.activity.recent(50).filter((event) => event.taskId === taskId)
    assert.ok(activity.length > 0)
    assert.ok(activity.every((event) => String(event.userId) === '202'))
    assert.ok(activity.every((event) => event.scopeId === 'personal-202'))
    assert.equal(env.usage.byUser().find((item) => item.userId === '202')?.requests, 1)
  } finally {
    await env.close()
  }
})

test('an old v2 client without principal derives the owner from its trusted route', async () => {
  const outbox = outboxRecorder()
  const env = await createBotHarness({
    configEnv: { ALLOWED_USER_IDS: '101,202', ALERT_CHAT_ID: '101', BRIDGE_ROUTE_BOT_ID: '999', BRIDGE_ROUTE_CHAT_ID: '202' },
    deliveryFetch: outbox.fetchImpl,
  })
  try {
    const { taskId } = await env.bot.submitV2Task({
      task: 'задача старого клиента',
      requestId: 'req-old-client',
      route: { ...ROUTE, chatId: '202' },
    })
    await env.bot.worker
    assert.equal(env.journal.get(taskId).userId, '202')
  } finally {
    await env.close()
  }
})

test('a question goes to the original conversation and the reply continues the same task', async () => {
  const outbox = outboxRecorder()
  let calls = 0
  const env = await createBotHarness({
    configEnv: { BRIDGE_ROUTE_BOT_ID: '999', BRIDGE_ROUTE_CHAT_ID: '42' },
    deliveryFetch: outbox.fetchImpl,
    runner: {
      async run() {
        calls += 1
        if (calls === 1) {
          return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'ВОПРОС: какой нужен формат?', sessionId: 's-q', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 30 }
        }
        return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'Готово в DOCX', sessionId: 's-q', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 30 }
      },
    },
  })
  try {
    const { taskId } = await env.bot.submitV2Task({ task: 'сделай отчёт', requestId: 'req-q', route: ROUTE })
    await env.bot.worker
    assert.equal(env.bot.taskState(taskId).execution, STATUS.awaiting_owner)
    const question = outbox.events.find((event) => event.type === 'question')
    assert.ok(question)
    assert.equal(question.eventId, `${taskId}:question:1`)
    assert.match(question.question.text, /какой нужен формат/)

    const reply = await env.bot.replyTask(taskId, { requestId: 'reply-1', text: 'DOCX' })
    assert.equal(reply.state, 'queued')
    await env.bot.worker
    assert.equal(env.bot.taskState(taskId).execution, STATUS.done)
    assert.ok(outbox.events.some((event) => event.type === 'result' && /DOCX/.test(event.text)))
    // Повтор того же ответа не продолжает задачу второй раз.
    const again = await env.bot.replyTask(taskId, { requestId: 'reply-1', text: 'DOCX' })
    assert.equal(again.state, 'queued')
    assert.equal(calls, 2)
  } finally {
    await env.close()
  }
})

test('a revision keeps the root/version and uses the previous result in the prompt', async () => {
  const outbox = outboxRecorder()
  const prompts = []
  const env = await createBotHarness({
    configEnv: { BRIDGE_ROUTE_BOT_ID: '999', BRIDGE_ROUTE_CHAT_ID: '42' },
    deliveryFetch: outbox.fetchImpl,
    runner: {
      async run(request) {
        prompts.push(request.task)
        return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'Готово', sessionId: 's1', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 30 }
      },
    },
  })
  try {
    const first = await env.bot.submitV2Task({ task: 'сделай отчёт', requestId: 'rev-1', route: ROUTE })
    await env.bot.worker
    const second = await env.bot.submitV2Task({ task: 'сократи раздел 2', requestId: 'rev-2', route: ROUTE, revisionOf: first.taskId })
    await env.bot.worker
    const state = env.bot.taskState(second.taskId)
    assert.equal(state.version, 2)
    assert.equal(state.rootTaskId, first.taskId)
    assert.equal(state.revisionOf, first.taskId)
    assert.match(prompts[1], /Это доработка ранее выданного результата/)
    assert.match(prompts[1], /сократи раздел 2/)
  } finally {
    await env.close()
  }
})

test('an input file from the contract reaches the task through the inbox', async () => {
  const outbox = outboxRecorder()
  const prompts = []
  const env = await createBotHarness({
    configEnv: { BRIDGE_ROUTE_BOT_ID: '999', BRIDGE_ROUTE_CHAT_ID: '42' },
    deliveryFetch: outbox.fetchImpl,
    runner: {
      async run(request) {
        prompts.push(request.task)
        return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'прочитал', sessionId: 's1', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 30 }
      },
    },
  })
  try {
    const record = await env.files.create({ bytes: Buffer.from('данные'), name: 'план.txt', mime: 'text/plain', direction: 'input' })
    await env.bot.submitV2Task({
      task: 'прочитай файл',
      requestId: 'file-1',
      route: ROUTE,
      attachments: [{ fileId: record.fileId, kind: 'document', name: 'план.txt' }],
    })
    await env.bot.worker
    assert.match(prompts[0], /план\.txt/)
    assert.match(prompts[0], /inbox\//)
    assert.ok(await env.files.read(record.fileId))
  } finally {
    await env.close()
  }
})

test('cancel stops a routed task without sending a cancellation event', async () => {
  const outbox = outboxRecorder()
  const env = await createBotHarness({
    configEnv: { BRIDGE_ROUTE_BOT_ID: '999', BRIDGE_ROUTE_CHAT_ID: '42' },
    deliveryFetch: outbox.fetchImpl,
    runner: {
      async run({ signal }) {
        await new Promise((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', resolve, { once: true })
        })
        return { ok: false, aborted: true, exitCode: null, timedOut: false, text: '', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 10 }
      },
    },
  })
  try {
    const { taskId } = await env.bot.submitV2Task({ task: 'долгая задача', requestId: 'cancel-1', route: ROUTE })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const result = await env.bot.cancelTaskById(taskId, { requestId: 'cancel-req-1' })
    assert.equal(result.state, 'cancelled')
    await env.bot.worker
    assert.equal(env.bot.taskState(taskId).execution, STATUS.cancelled)
    assert.equal(outbox.events.some((event) => event.type === 'cancelled'), false)
    // Та же отмена по тому же ключу идемпотентна.
    assert.equal((await env.bot.cancelTaskById(taskId, { requestId: 'cancel-req-1' })).state, 'cancelled')
  } finally {
    await env.close()
  }
})
