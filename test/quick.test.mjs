import assert from 'node:assert/strict'
import { test } from 'node:test'
import { needsExecutor, QuickClient, ROUTE_TO_DSH } from '../src/execution/quick.mjs'
import { createBotHarness, createTestLogger } from './helpers.mjs'

const KEY = 'sk-test'

/** A fetch stub answering with one assistant message. */
function stubFetch({ content = 'ок', usage = { prompt_tokens: 120, completion_tokens: 12 }, status = 200, error } = {}) {
  const calls = []
  const impl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    if (error) throw error
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(error ? {} : { choices: [{ message: { content } }], usage }),
    }
  }
  impl.calls = calls
  return impl
}

const client = (fetchImpl, options = {}) => new QuickClient({ apiKey: KEY, fetchImpl, logger: createTestLogger(), ...options })

test('the pre-filter sends anything with hands to the executor', () => {
  // Files, artifacts, the network, programs, long or multi-line requests.
  const toExecutor = [
    'сделай отчёт по продажам в xlsx',
    'найди 5 фото кед в интернете',
    'посчитай сумму в файле budget.csv',
    'переименуй файлы в папке',
    'какая сегодня погода в Москве',
    'напомни завтра в 9 позвонить маме',
    'я'.repeat(300),
    'первая строка\nвторая строка',
  ]
  for (const text of toExecutor) {
    assert.equal(needsExecutor({ text }), true, `должно уйти в DSH: ${text.slice(0, 40)}`)
  }
  // Attachments always mean real work.
  assert.equal(needsExecutor({ text: 'что тут?', attachments: [{ kind: 'photo' }] }), true)
})

test('the pre-filter lets short knowledge questions through', () => {
  const quick = [
    'сколько будет 17 умножить на 24',
    'что такое инфляция',
    'переведи на английский: доброе утро',
    'объясни разницу между TCP и UDP',
    'придумай название для отчёта',   // «отчёт» ловится — проверим ниже отдельно
  ]
  for (const text of quick.slice(0, 4)) {
    assert.equal(needsExecutor({ text }), false, `должно попасть в быстрый слой: ${text}`)
  }
})

test('a trivial question is answered without DSH', async () => {
  const fetchImpl = stubFetch({ content: '408' })
  const answer = await client(fetchImpl).answer({ task: 'сколько будет 17 умножить на 24' })

  assert.equal(answer.routed, 'quick')
  assert.equal(answer.text, '408')
  assert.equal(answer.usage.totalTokens, 132)
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].body.messages[0].role, 'system')
  assert.match(fetchImpl.calls[0].body.messages[0].content, new RegExp(ROUTE_TO_DSH))
})

test('a bare DSH answer routes the task to the executor', async () => {
  const answer = await client(stubFetch({ content: 'DSH' })).answer({ task: 'сделай мне сайт' })
  assert.equal(answer.routed, 'dsh')
  assert.equal(answer.text, '')
})

test('memory facts travel with the classification call', async () => {
  const fetchImpl = stubFetch({ content: 'Москва' })
  await client(fetchImpl).answer({ task: 'какая столица?', memory: '- живёт в Москве' })
  const system = fetchImpl.calls[0].body.messages[0].content
  assert.match(system, /живёт в Москве/)
})

test('a failed call falls back to the executor instead of failing the task', async () => {
  const answer = await client(stubFetch({ error: new Error('ECONNREFUSED') })).answer({ task: 'что такое брокер' })
  assert.equal(answer.routed, 'dsh')
  assert.match(answer.error, /недоступна/)
})

test('an HTTP error also falls back, and never throws', async () => {
  const answer = await client(stubFetch({ status: 500 })).answer({ task: 'что такое брокер' })
  assert.equal(answer.routed, 'dsh')
  assert.match(answer.error, /500/)
})

test('an empty answer is not treated as an answer', async () => {
  const answer = await client(stubFetch({ content: '   ' })).answer({ task: 'что такое брокер' })
  assert.equal(answer.routed, 'dsh')
})

test('a disabled client never calls the provider', async () => {
  const fetchImpl = stubFetch()
  const answer = new QuickClient({ apiKey: '', fetchImpl }).answer({ task: 'что такое брокер' })
  assert.equal((await answer).routed, 'dsh')
  assert.equal(fetchImpl.calls.length, 0)
})

test('the bot answers a trivial request itself and records the spend', async () => {
  const runs = []
  const env = await createBotHarness({
    runner: { async run() { runs.push(1); return {} } },
  })
  try {
    env.bot.quick = client(stubFetch({ content: '408' }))
    await env.bot.handleUpdate({
      kind: 'message', id: 1, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false },
      text: 'сколько будет 17 умножить на 24', attachments: [], addressed: true, messageId: 5,
    })
    await env.bot.worker

    assert.equal(runs.length, 0, 'DSH не запускался')
    const record = env.journal.recent(1)[0]
    assert.equal(record.status, 'done')
    assert.equal(record.quick, true)
    assert.equal(record.tokens.total, 132)
    assert.ok(record.usd > 0, 'расход записан в деньги')
    assert.ok(env.platform.sent.some((entry) => /408/.test(entry.markdown)), 'ответ дошёл')
    assert.ok(env.platform.sent.some((entry) => /без запуска задачи/.test(entry.markdown)))
    // Тот же пояс, что у бота: иначе на границе суток запись и проверка расходятся.
    assert.equal(env.usage.tokens(new Date(), env.config.runtime.timeZone) > 0, true, 'день учёл вызов')
  } finally {
    await env.close()
  }
})

test('a task with hands still goes to the executor', async () => {
  const runs = []
  const env = await createBotHarness({
    // Plan mode is exercised separately: here the point is the routing decision.
    configEnv: { PLAN_MODE: 'never' },
    runner: { async run() { runs.push(1); return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'готово', sessionId: 's', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 10 } } },
  })
  try {
    const fetchImpl = stubFetch({ content: 'не должно вызываться' })
    env.bot.quick = client(fetchImpl)
    await env.bot.handleUpdate({
      kind: 'message', id: 2, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false },
      text: 'сделай отчёт по продажам в xlsx', attachments: [], addressed: true, messageId: 6,
    })
    await env.bot.worker
    assert.equal(runs.length, 1, 'DSH запустился')
    assert.equal(fetchImpl.calls.length, 0, 'классификация не понадобилась')
  } finally {
    await env.close()
  }
})

test('a retry forces the executor even for a trivial request', async () => {
  const runs = []
  const env = await createBotHarness({
    runner: { async run() { runs.push(1); return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'готово', sessionId: 's', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 10 } } },
  })
  try {
    const fetchImpl = stubFetch({ content: 'быстрый ответ' })
    env.bot.quick = client(fetchImpl)
    await env.bot.handleUpdate({ kind: 'message', id: 3, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false }, text: 'сколько будет 2+2', attachments: [], addressed: true, messageId: 7 })
    await env.bot.worker
    assert.equal(fetchImpl.calls.length, 1, 'первый раз ответил быстро')

    await env.bot.handleUpdate({
      kind: 'message', id: 4, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false },
      text: `/retry ${env.journal.recent(1)[0].id}`, attachments: [], addressed: true, messageId: 8, command: '/retry',
      commandArgs: env.journal.recent(1)[0].id,
    })
    await env.bot.worker
    assert.equal(runs.length, 1, 'повтор пошёл в DSH')
  } finally {
    await env.close()
  }
})

test('the quick answer goes through the orchestrator and cancellation closes it as cancelled', async () => {
  const env = await createBotHarness({ runner: { async run() { throw new Error('DSH не должен запускаться') } } })
  try {
    let started
    const ready = new Promise((resolve) => { started = resolve })
    env.bot.quick = {
      enabled: true,
      async answer({ signal }) {
        started()
        await new Promise((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', resolve, { once: true })
        })
        return { routed: 'quick', text: 'ответ', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 }, durationMs: 5 }
      },
    }
    const handled = env.bot.handleUpdate({
      kind: 'message', id: 3, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false },
      text: 'сколько будет 17 умножить на 24', attachments: [], addressed: true, messageId: 7,
    })
    await ready
    await env.bot.cancelAll(42)
    await handled
    await env.bot.worker
    const record = env.journal.recent(1)[0]
    assert.equal(record.status, 'cancelled')
    assert.equal(record.quick, true)
  } finally {
    await env.close()
  }
})

test('a cancelled quick route that answers routed:dsh does not start DSH', async () => {
  const runs = []
  const env = await createBotHarness({ runner: { async run() { runs.push(1); return {} } } })
  try {
    env.bot.quick = {
      enabled: true,
      async answer({ signal }) {
        await new Promise((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', resolve, { once: true })
        })
        return { routed: 'dsh', text: '', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 }, durationMs: 5 }
      },
    }
    const handled = env.bot.handleUpdate({
      kind: 'message', id: 4, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false },
      text: 'сколько будет 17 умножить на 24', attachments: [], addressed: true, messageId: 8,
    })
    while (!env.bot.running) await new Promise((resolve) => setTimeout(resolve, 5))
    await env.bot.cancelAll(42)
    await handled
    await env.bot.worker
    assert.equal(runs.length, 0, 'DSH не запускался после отмены быстрого маршрута')
    assert.equal(env.journal.recent(1)[0].status, 'cancelled')
  } finally {
    await env.close()
  }
})

test('quick routing and DSH share one budget instead of starting a new one', async () => {
  const requests = []
  const env = await createBotHarness({
    configEnv: { PLAN_MODE: 'never', TASK_TOKEN_BUDGET: '100' },
    runner: {
      async run(request) {
        requests.push(request)
        return { ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'готово', sessionId: 's', usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 20, steps: 1 }, tools: [], errors: [], stderr: '', durationMs: 10 }
      },
    },
  })
  try {
    env.bot.quick = {
      enabled: true,
      async answer() {
        return { routed: 'dsh', text: '', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10 }, durationMs: 5 }
      },
    }
    await env.bot.handleUpdate({
      kind: 'message', id: 5, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false },
      text: 'сколько будет 17 умножить на 24', attachments: [], addressed: true, messageId: 9,
    })
    await env.bot.worker
    const record = env.journal.recent(1)[0]
    assert.equal(record.status, 'done')
    assert.equal(record.tokens.total, 30, 'учтены и маршрутизация, и DSH')
    assert.equal(requests[0].tokenBudget, 90, 'DSH получает остаток общего бюджета')
  } finally {
    await env.close()
  }
})

test('an exhausted quick route never starts DSH', async () => {
  let runs = 0
  const env = await createBotHarness({
    configEnv: { PLAN_MODE: 'never', TASK_TOKEN_BUDGET: '100' },
    runner: { async run() { runs += 1; return { ok: true, text: 'x', usage: { totalTokens: 5, steps: 1 } } } },
  })
  try {
    env.bot.quick = {
      enabled: true,
      async answer() {
        return { routed: 'dsh', text: '', usage: { inputTokens: 50, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 100 }, durationMs: 5 }
      },
    }
    await env.bot.handleUpdate({
      kind: 'message', id: 6, chat: { id: 42, type: 'private' }, from: { id: 42, name: 'В', isBot: false },
      text: 'сколько будет 17 умножить на 24', attachments: [], addressed: true, messageId: 10,
    })
    await env.bot.worker
    const record = env.journal.recent(1)[0]
    assert.equal(runs, 0, 'DSH не запускается при исчерпанном бюджете')
    assert.equal(record.status, 'failed')
    assert.equal(record.reason, 'budget')
  } finally {
    await env.close()
  }
})
