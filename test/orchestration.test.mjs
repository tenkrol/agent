/**
 * Оркестратор этапа 1: единый цикл, отмена, остаточный бюджет, статусы.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOrchestrator } from '../src/orchestration/orchestrator.mjs'
import { createDshExecutor } from '../src/agents/dsh/index.mjs'
import { createBudget, minLimit } from '../src/orchestration/budget.mjs'
import { assertTransition, classifyOutcome, STAGE } from '../src/orchestration/lifecycle.mjs'
import { createExecutorRegistry } from '../src/orchestration/registry.mjs'

const usage = (totalTokens, steps = 1) => ({ totalTokens, steps })
const verifier = (maxAttempts = 1) => ({ maxAttempts })

test('orchestrator runs one attempt and returns the journal status', async () => {
  const calls = []
  const executor = { id: 'dsh', capabilities: [], execute: async (request) => { calls.push(request); return { ok: true, text: 'готово', usage: usage(100) } } }
  const orchestrator = createOrchestrator({
    executors: [executor],
    verifier: verifier(1),
    limits: { tokenLimit: 1000, maxSteps: 5, timeLimitMs: 10_000 },
    verify: async () => ({ status: 'passed', criteria: [] }),
  })
  const outcome = await orchestrator.run({ job: { id: 't1', text: 'сделай' }, task: 'сделай', signal: new AbortController().signal })
  assert.equal(outcome.status, STAGE.done)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 't1-1')
  assert.equal(calls[0].tokenBudget, 1000)
})

test('cancel during repair stops the active attempt and never reports done', async () => {
  const controller = new AbortController()
  let run = 0
  const executor = {
    id: 'dsh',
    execute: async ({ signal }) => {
      run += 1
      if (run === 1) return { ok: true, text: 'результат', usage: usage(100) }
      controller.abort()
      return { ok: false, aborted: signal.aborted, text: '', usage: usage(50) }
    },
  }
  const orchestrator = createOrchestrator({
    executors: [executor],
    verifier: verifier(1),
    limits: { tokenLimit: 1000, maxSteps: 5, timeLimitMs: 10_000 },
    verify: async () => ({ status: 'failed', criteria: [{ id: 'sections', status: 'failed', evidence: 'нет раздела' }] }),
  })
  const outcome = await orchestrator.run({ job: { id: 't2', text: 'сделай' }, task: 'сделай', signal: controller.signal })
  assert.equal(outcome.status, STAGE.cancelled)
  assert.equal(run, 2)
})

test('repair gets only the remaining token budget', async () => {
  const budgets = []
  let run = 0
  const executor = {
    id: 'dsh',
    execute: async (request) => {
      budgets.push(request.tokenBudget)
      run += 1
      return { ok: true, text: 'x', usage: usage(run === 1 ? 7000 : 500) }
    },
  }
  const orchestrator = createOrchestrator({
    executors: [executor],
    verifier: verifier(1),
    limits: { tokenLimit: 10_000, maxSteps: 10, timeLimitMs: 10_000 },
    verify: async ({ result }) => (result.text === 'x' && budgets.length === 1
      ? { status: 'failed', criteria: [{ id: 'sections', status: 'failed', evidence: 'нет' }], usage: usage(1000) }
      : { status: 'passed', criteria: [] }),
  })
  const outcome = await orchestrator.run({ job: { id: 't3', text: 'сделай' }, task: 'сделай', signal: new AbortController().signal })
  assert.equal(budgets[0], 10_000)
  assert.equal(budgets[1], 2000)
  assert.equal(outcome.status, STAGE.done)
  assert.equal(outcome.attempts, 1)
})

test('no repair when the budget is exhausted after verification', async () => {
  const executor = { id: 'dsh', execute: async () => ({ ok: true, text: 'x', usage: usage(9500) }) }
  const orchestrator = createOrchestrator({
    executors: [executor],
    verifier: verifier(1),
    limits: { tokenLimit: 10_000 },
    verify: async () => ({ status: 'failed', criteria: [{ id: 'sections', status: 'failed' }], usage: usage(1000) }),
  })
  const outcome = await orchestrator.run({ job: { id: 't4', text: 'сделай' }, task: 'сделай', signal: new AbortController().signal })
  assert.equal(outcome.status, STAGE.partial)
  assert.equal(outcome.reason, 'budget')
  assert.equal(outcome.attempts, 0)
})

test('unknown usage blocks a second repair attempt', async () => {
  let runs = 0
  const executor = { id: 'dsh', execute: async () => { runs += 1; return { ok: true, text: 'x', usage: {} } } }
  const orchestrator = createOrchestrator({
    executors: [executor],
    verifier: verifier(2),
    limits: { tokenLimit: 10_000 },
    verify: async () => ({ status: 'failed', criteria: [{ id: 'sections', status: 'failed' }] }),
  })
  const outcome = await orchestrator.run({ job: { id: 't5', text: 'сделай' }, task: 'сделай', signal: new AbortController().signal })
  // Первый расход неизвестен: второй запуск не открывается как «бесплатный».
  assert.equal(runs, 1)
  assert.equal(outcome.reason, 'unknown_budget')
})

test('procedure limits shrink the global ceiling', () => {
  assert.equal(minLimit(0, 500), 500)
  assert.equal(minLimit(1000, 0), 1000)
  assert.equal(minLimit(1000, 500), 500)
  const budget = createBudget({ tokenLimit: 100, maxSteps: 2 })
  budget.consume({ totalTokens: 40, steps: 1 })
  assert.deepEqual(budget.remaining().tokens, 60)
  assert.deepEqual(budget.remaining().steps, 1)
  assert.equal(budget.exhausted(), false)
})

test('lifecycle rejects unknown transitions and maps cancellation', () => {
  assert.doesNotThrow(() => assertTransition(STAGE.queued, STAGE.executing))
  assert.throws(() => assertTransition(STAGE.done, STAGE.executing), /недопустимый переход/)
  assert.equal(classifyOutcome({ result: { ok: false, aborted: true }, stopping: true }).status, STAGE.interrupted)
  assert.equal(classifyOutcome({ result: { ok: false, aborted: true } }).status, STAGE.cancelled)
  assert.equal(classifyOutcome({ result: { ok: false, budgetExceeded: true } }).reason, 'budget')
  assert.equal(classifyOutcome({ result: { ok: true }, verification: { status: 'unavailable' } }).status, STAGE.partial)
})

test('registry refuses unknown executors instead of substituting', () => {
  const registry = createExecutorRegistry({ executors: [{ id: 'dsh' }] })
  assert.deepEqual(registry.ids(), ['dsh'])
  assert.throws(() => registry.get('other'), /неизвестный исполнитель/)
  const orchestrator = createOrchestrator({ executors: [{ id: 'dsh' }] })
  return assert.rejects(
    () => orchestrator.run({ job: { id: 't' }, task: 'x', signal: new AbortController().signal, executorId: 'other' }),
    /неизвестный исполнитель/,
  )
})

test('dsh adapter passes the remaining limits to the existing runner', async () => {
  const calls = []
  const executor = createDshExecutor({ runner: { run: async (request) => { calls.push(request); return { ok: true, usage: usage(10) } } } })
  await executor.execute({ task: 'x', signal: undefined, id: 't-1', tokenBudget: 123, maxSteps: 4, timeoutMs: 5000 })
  assert.deepEqual(calls[0], { task: 'x', sessionId: undefined, signal: undefined, id: 't-1', tokenBudget: 123, maxSteps: 4, timeoutMs: 5000 })
})

test('cancel during the second verification never reports done', async () => {
  const controller = new AbortController()
  let verifyCalls = 0
  const executor = { id: 'dsh', execute: async () => ({ ok: true, text: 'x', usage: usage(10) }) }
  const orchestrator = createOrchestrator({
    executors: [executor],
    verifier: verifier(1),
    limits: { tokenLimit: 10_000, maxSteps: 10, timeLimitMs: 10_000 },
    verify: async () => {
      verifyCalls += 1
      if (verifyCalls === 1) return { status: 'failed', criteria: [{ id: 'sections', status: 'failed', evidence: 'нет' }] }
      controller.abort()
      return { status: 'passed', criteria: [] }
    },
  })
  const outcome = await orchestrator.run({ job: { id: 't6', text: 'сделай' }, task: 'сделай', signal: controller.signal })
  assert.equal(verifyCalls, 2)
  assert.equal(outcome.status, STAGE.cancelled)
})

test('verification usage is charged and exhausting the budget blocks done', async () => {
  const executor = { id: 'dsh', execute: async () => ({ ok: true, text: 'x', usage: usage(90) }) }
  const orchestrator = createOrchestrator({
    executors: [executor],
    verifier: verifier(1),
    limits: { tokenLimit: 100, maxSteps: 10, timeLimitMs: 10_000 },
    verify: async () => ({ status: 'passed', criteria: [], usage: usage(20) }),
  })
  const outcome = await orchestrator.run({ job: { id: 't7', text: 'сделай' }, task: 'сделай', signal: new AbortController().signal })
  assert.equal(outcome.budget.tokens, 110)
  assert.notEqual(outcome.status, STAGE.done)
  assert.equal(outcome.reason, 'budget')
})

test('verification usage is reported to the journal callback as unknown when absent', async () => {
  const events = []
  const executor = { id: 'dsh', execute: async () => ({ ok: true, text: 'x', usage: usage(10) }) }
  const orchestrator = createOrchestrator({
    executors: [executor],
    verifier: verifier(0),
    limits: { tokenLimit: 10_000 },
    verify: async () => ({ status: 'passed', criteria: [], usage: { totalTokens: undefined, unknown: true } }),
  })
  await orchestrator.run({
    job: { id: 't8' },
    task: 'x',
    signal: new AbortController().signal,
    onUsage: (value, info) => events.push({ value, info }),
  })
  const verifying = events.find((entry) => entry.info.stage === STAGE.verifying)
  assert.ok(verifying)
  assert.equal(verifying.info.unknown, true)
})

test('verification does not start after the token budget is exhausted', async () => {
  let verifyCalls = 0
  const executor = { id: 'dsh', execute: async () => ({ ok: true, text: 'x', usage: usage(100) }) }
  const orchestrator = createOrchestrator({
    executors: [executor],
    verifier: verifier(1),
    limits: { tokenLimit: 100 },
    verify: async () => { verifyCalls += 1; return { status: 'passed', criteria: [] } },
  })
  const outcome = await orchestrator.run({ job: { id: 't9' }, task: 'x', signal: new AbortController().signal })
  assert.equal(verifyCalls, 0)
  assert.notEqual(outcome.status, STAGE.done)
  assert.equal(outcome.reason, 'budget')
})
