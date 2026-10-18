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
