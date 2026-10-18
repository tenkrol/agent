import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshExecutor } from '../src/agents/dsh/index.mjs'
import { createOrchestrator } from '../src/orchestration/orchestrator.mjs'
import { chooseExecutorId } from '../src/core/bot.mjs'

test('files executor adds its instruction prefix and keeps the attempt id', async () => {
  const calls = []
  const executor = createDshExecutor({
    id: 'files',
    capabilities: ['files', 'documents'],
    taskPrefix: 'ФАЙЛОВЫЙ: ',
    runner: { async run(request) { calls.push(request); return { ok: true, text: 'ok', usage: { totalTokens: 1, steps: 1 } } } },
  })
  assert.equal(executor.id, 'files')
  await executor.execute({ task: 'сделай xlsx', id: 'attempt-1' })
  assert.equal(calls[0].task, 'ФАЙЛОВЫЙ: сделай xlsx')
  assert.equal(calls[0].id, 'attempt-1')
})

test('orchestrator routes a task to the selected executor', async () => {
  const calls = []
  const orchestrator = createOrchestrator({
    executors: [
      { id: 'dsh', capabilities: [], execute: async () => { calls.push('dsh'); return { ok: true, text: 'x', usage: { totalTokens: 1, steps: 1 } } } },
      { id: 'files', capabilities: ['files'], execute: async () => { calls.push('files'); return { ok: true, text: 'x', usage: { totalTokens: 1, steps: 1 } } } },
    ],
    selectExecutor: () => 'files',
    verifier: { maxAttempts: 1 },
    limits: { tokenLimit: 1000, maxSteps: 5, timeLimitMs: 10_000 },
    verify: async () => ({ status: 'passed', criteria: [] }),
  })
  const outcome = await orchestrator.run({ job: { id: 't1' }, task: 'сделай xlsx', signal: new AbortController().signal })
  assert.equal(outcome.status, 'done')
  assert.deepEqual(calls, ['files'])
})


test('chooseExecutorId routes host tasks to monitor, files to files, explicit ids untouched', () => {
  assert.equal(chooseExecutorId({ task: 'проверь диск и память сервера' }), 'monitor')
  assert.equal(chooseExecutorId({ task: 'сделай xlsx' }), 'files')
  assert.equal(chooseExecutorId({ task: 'сделай xlsx', executorId: 'quick' }), 'quick')
})
