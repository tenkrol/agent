import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBotHarness } from './helpers.mjs'

test('ready request is executed through the durable queue and not duplicated', async () => {
  const env = await createBotHarness()
  try {
    let runs = 0
    env.bot.implementer = async () => { runs += 1; return { state: 'verified', results: [{ branch: 'impl/REQ-1000-PLA-1' }] } }
    const first = await env.bot.enqueueImplementation({ requestId: 'REQ-1000', revision: 1 })
    assert.equal(first.queued, true)
    await env.bot.worker
    assert.equal(runs, 1)
    assert.equal(env.journal.get(first.taskId).status, 'done')
    const second = await env.bot.enqueueImplementation({ requestId: 'REQ-1000', revision: 1 })
    assert.equal(second.duplicate, true)
    await env.bot.worker
    assert.equal(runs, 1, 'идемпотентный ключ не создаёт вторую реализацию')
  } finally {
    await env.close()
  }
})

test('an implementation job cancelled through the queue does not finish done', async () => {
  const env = await createBotHarness()
  try {
    env.bot.implementer = async ({ signal }) => {
      await new Promise((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', resolve, { once: true })
      })
      throw new Error('cancelled')
    }
    const queued = await env.bot.enqueueImplementation({ requestId: 'REQ-1001', revision: 1 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await env.bot.cancelAll(env.bot.alertChatId())
    await env.bot.worker
    assert.notEqual(env.journal.get(queued.taskId).status, 'done')
  } finally {
    await env.close()
  }
})

test('a queued implementation keeps its type and revision after JSONL restart', async () => {
  let implementations = 0
  let ordinaryRuns = 0
  const env = await createBotHarness({
    configEnv: { QUEUE_STORE: 'jsonl', ROUTING: 'off', PLAN_MODE: 'never' },
    runner: { async run() { ordinaryRuns += 1; return { ok: true, text: 'wrong path', usage: {} } } },
    implementer: async ({ requestId, retry }) => {
      implementations += 1
      assert.equal(requestId, 'REQ-1002')
      assert.equal(retry, true)
      return { state: 'verified', results: [{ branch: 'impl/REQ-1002-PLA-52' }] }
    },
    seedJournal: async ({ journal }) => {
      await journal.openQueued({
        id: 'impl-REQ-1002-r7',
        kind: 'implement',
        requestId: 'REQ-1002',
        revision: 7,
        retry: true,
        chatId: 42,
        userId: 42,
        text: 'Реализация заявки REQ-1002 (r7)',
        attachments: [],
        requestKey: 'implement:REQ-1002:r7:retry',
      })
    },
  })
  try {
    await env.bot.worker
    assert.equal(implementations, 1)
    assert.equal(ordinaryRuns, 0)
    assert.equal(env.journal.get('impl-REQ-1002-r7').status, 'done')
  } finally {
    await env.close()
  }
})
