/** Регрессии PLA-52: предел workers, адресная отмена и личная доставка. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { test } from 'node:test'
import { createBotHarness } from './helpers.mjs'

const configEnv = {
  QUEUE_STORE: 'sqlite',
  QUEUE_WORKERS: '2',
  WORKSPACE_PER_TASK: 'true',
  ROUTING: 'off',
  PLAN_MODE: 'never',
  TASK_PER_USER_CONCURRENCY: '0',
}

const prepareState = async ({ config }) => {
  await fs.mkdir(config.workspace.stateDir, { recursive: true })
}

const job = (id) => ({
  id,
  chatId: 42,
  userId: 42,
  text: `Выполни задачу ${id}`,
  attachments: [],
  forceDsh: true,
})

const until = async (predicate) => {
  for (let index = 0; index < 300; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('не наступило ожидаемое условие')
}

const close = async (env) => {
  await env.bot.stop()
  env.bot.queueStore?.close()
  await env.close()
}

test('QUEUE_WORKERS limits simultaneous executions and drains the rest', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let active = 0
  let maximum = 0
  let completed = 0
  const env = await createBotHarness({
    configEnv,
    seedJournal: prepareState,
    runner: {
      async run() {
        active += 1
        maximum = Math.max(maximum, active)
        await gate
        active -= 1
        completed += 1
        return { ok: true, text: 'готово', usage: {}, durationMs: 1 }
      },
    },
  })
  try {
    for (let index = 1; index <= 4; index += 1) await env.bot.enqueueJob(job(`parallel-${index}`))
    await until(() => active === 2)
    assert.equal(maximum, 2)
    release()
    await env.bot.worker
    assert.equal(completed, 4)
    assert.equal(maximum, 2)
  } finally {
    release()
    await close(env)
  }
})

test('contract cancellation aborts the selected parallel task by id', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const attempts = new Map()
  const env = await createBotHarness({
    configEnv,
    seedJournal: prepareState,
    runner: {
      async run({ id, signal }) {
        attempts.set(String(id).replace(/-1$/, ''), signal)
        await gate
        return { ok: true, text: 'готово', usage: {}, durationMs: 1 }
      },
    },
  })
  try {
    await env.bot.enqueueJob(job('cancel-a'))
    await env.bot.enqueueJob(job('cancel-b'))
    await until(() => attempts.size === 2)
    const response = await env.bot.cancelTaskById('cancel-b', { requestId: 'cancel-b-request' })
    assert.equal(response.state, 'cancelled')
    assert.equal(attempts.get('cancel-b').aborted, true)
    assert.equal(attempts.get('cancel-a').aborted, false)
    release()
    await env.bot.worker
  } finally {
    release()
    await close(env)
  }
})

test('failed personal Telegram send stays pending and retryable', async () => {
  const env = await createBotHarness({
    configEnv: { ...configEnv, QUEUE_WORKERS: '1' },
    seedJournal: prepareState,
    runner: {
      async run() {
        return { ok: true, text: 'важный результат', usage: {}, durationMs: 1 }
      },
    },
  })
  try {
    env.platform.sendText = async () => { throw new Error('Telegram unavailable') }
    await env.bot.enqueueJob(job('delivery-failure'))
    await env.bot.worker
    const [record] = env.deliveries.ofTask('delivery-failure')
    assert.equal(record.channel, 'personal')
    assert.equal(record.state, 'pending')
    assert.equal(record.outcome, 'unknown')
    assert.equal(env.bot.queueStore.pendingOutbox().length, 0, 'событие уже передано долговечной доставке')
    assert.equal(env.deliveries.due(Date.now() + 24 * 3600 * 1000).length, 1)
  } finally {
    await close(env)
  }
})
