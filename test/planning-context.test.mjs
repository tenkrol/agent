/**
 * PLA-22: планирование живёт в общем контексте задачи (сигнал и бюджет).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBotHarness } from './helpers.mjs'

const message = (text, id = 1) => ({
  kind: 'message', id, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false },
  text, attachments: [], addressed: true, messageId: id,
})

test('cancel during planning closes the task and never starts DSH', async () => {
  let runs = 0
  const env = await createBotHarness({
    configEnv: { PLAN_MODE: 'always' },
    runner: { async run() { runs += 1; return { ok: true, text: 'x', usage: { totalTokens: 1 } } } },
  })
  try {
    env.bot.quick = {
      enabled: true,
      async answer() { return { routed: 'dsh', text: '', usage: { totalTokens: 5 }, durationMs: 1 } },
      async plan({ signal }) {
        await new Promise((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', resolve, { once: true })
        })
        return { plan: '', usage: { totalTokens: 0 }, durationMs: 1 }
      },
    }
    const handled = env.bot.handleUpdate(message('сделай отчёт по продажам в xlsx'))
    while (!env.bot.running) await new Promise((resolve) => setTimeout(resolve, 5))
    await env.bot.cancelAll(42)
    await handled
    await env.bot.worker
    assert.equal(runs, 0, 'DSH не запускается после отмены планирования')
    assert.equal(env.journal.recent(1)[0].status, 'cancelled')
  } finally {
    await env.close()
  }
})

test('unattended planning spends from the same budget before DSH', async () => {
  const requests = []
  const env = await createBotHarness({
    configEnv: { PLAN_MODE: 'never', PLAN_UNATTENDED: 'true', TASK_TOKEN_BUDGET: '100' },
    runner: { async run(request) { requests.push(request); return { ok: true, text: 'готово', usage: { totalTokens: 20, steps: 1 } } } },
  })
  try {
    env.bot.quick = {
      enabled: true,
      async plan() { return { plan: 'план', usage: { totalTokens: 30 }, durationMs: 1 } },
    }
    const accepted = await env.bot.submitBridgedTask({ task: 'сделай файл отчёта', source: 'test', requestId: 'plan-budget-1' })
    await env.bot.worker
    assert.ok(accepted.taskId)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].tokenBudget, 70, 'планирование вычтено из бюджета runner')
  } finally {
    await env.close()
  }
})

test('QUEUE_WORKERS>1 is rejected before the bot starts', async () => {
  await assert.rejects(
    () => createBotHarness({ configEnv: { QUEUE_WORKERS: '2' } }),
    /QUEUE_WORKERS>1 запрещён/,
  )
})
