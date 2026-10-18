/**
 * E0-A: потеря аренды останавливает реальный runner, а не только пишет stale.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBotHarness } from './helpers.mjs'

test('losing the lease aborts the real runner signal and does not close the task', async () => {
  let runnerSignal
  let started
  const ready = new Promise((resolve) => { started = resolve })
  const env = await createBotHarness({
    configEnv: { PLAN_MODE: 'never' },
    runner: {
      async run({ signal }) {
        runnerSignal = signal
        started()
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
          usage: { totalTokens: 1, steps: 1 },
          tools: [],
          errors: [],
          stderr: '',
          durationMs: 5,
        }
      },
    },
  })
  try {
    const lease = new AbortController()
    const job = {
      id: 'lease-task-1',
      chatId: 42,
      userId: 42,
      text: 'сделай файл отчёта',
      brief: 'сделай файл отчёта',
      attachments: [],
    }
    const running = env.bot.executeTask(job, { leaseSignal: lease.signal, owns: () => true })
    await ready
    lease.abort()
    await running
    assert.equal(runnerSignal.aborted, true, 'runner получил abort от потери аренды')
    const record = env.journal.get('lease-task-1')
    assert.ok(record)
    assert.notEqual(record.status, 'cancelled', 'потеря аренды не маскируется отменой')
    assert.notEqual(record.status, 'failed', 'старая попытка не пишет failed')
  } finally {
    await env.close()
  }
})

test('accepted outbox is re-enqueued after a crash before delivery', async () => {
  const env = await createBotHarness({ runner: { async run() { return { ok: true, text: 'x', usage: { totalTokens: 1, steps: 1 } } } } })
  try {
    const enqueued = []
    const marked = []
    env.bot.delivery = { enqueue: async (event) => enqueued.push(event) }
    env.bot.queueStore = {
      pendingOutbox: () => [{ event_id: 'e1', task_id: 't1', payload: { event: { eventId: 'e1', type: 'result' } } }],
      markOutboxEnqueued: (eventId) => marked.push(eventId),
    }
    await env.bot.recoverAcceptedOutbox()
    assert.equal(enqueued.length, 1)
    assert.equal(enqueued[0].eventId, 'e1')
    assert.deepEqual(marked, ['e1'])
  } finally {
    await env.close()
  }
})

test('a personal result accepted before delivery is re-sent from the outbox', async () => {
  const env = await createBotHarness({ runner: { async run() { return { ok: true, text: 'x', usage: { totalTokens: 1, steps: 1 } } } } })
  try {
    env.bot.queueStore = {
      pendingOutbox: () => [{
        event_id: 'personal:t1:1',
        task_id: 't1',
        payload: { kind: 'personal', chatId: 42, text: 'готово', replyToMessageId: undefined },
      }],
      markOutboxEnqueued: () => {},
    }
    await env.bot.recoverAcceptedOutbox()
    assert.ok(env.platform.sent.some((entry) => /готово/.test(entry.markdown)))
  } finally {
    await env.close()
  }
})

test('a stale accept gate prevents publishing a routed result', async () => {
  const env = await createBotHarness()
  try {
    const events = []
    env.bot.delivery = { enqueue: async (event) => events.push(event) }
    await env.bot.reportResult({
      job: { id: 'stale-1', chatId: 42, route: { platform: 'telegram', chatId: '42' }, resultVersion: 1 },
      result: { ok: true, text: 'готово', usage: { totalTokens: 1, steps: 1 }, durationMs: 5 },
      status: 'done',
      leaseContext: { accept: () => ({ ok: false, stale: true }) },
    })
    assert.equal(events.length, 0, 'stale accept не публикует результат')
  } finally {
    await env.close()
  }
})
