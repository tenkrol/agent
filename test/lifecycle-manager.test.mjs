/**
 * PLA-22: очередь, восстановление, awaiting и завершение принадлежат lifecycle.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTaskLifecycle } from '../src/orchestration/lifecycle-manager.mjs'

const memoryState = () => {
  const map = new Map()
  return { get: (key) => map.get(key), set: (key, value) => map.set(key, value), delete: (key) => map.delete(key), flush: async () => {} }
}

test('the lifecycle owns queue order and the single drain loop', async () => {
  const lifecycle = createTaskLifecycle({})
  lifecycle.enqueue({ id: 'a' })
  lifecycle.enqueue({ id: 'b' })
  assert.deepEqual(lifecycle.queue.map((job) => job.id), ['a', 'b'])
  const seen = []
  await lifecycle.drain({ runTask: async (job) => seen.push(job.id) })
  assert.deepEqual(seen, ['a', 'b'])
  assert.equal(lifecycle.queue.length, 0)
})

test('drain reports a task failure to the adapter and continues with the next', async () => {
  const lifecycle = createTaskLifecycle({})
  lifecycle.enqueue({ id: 'bad' })
  lifecycle.enqueue({ id: 'good' })
  const seen = []
  const errors = []
  await lifecycle.drain({
    runTask: async (job) => { if (job.id === 'bad') throw new Error('boom'); seen.push(job.id) },
    onError: async (job, error) => errors.push({ id: job.id, message: error.message }),
  })
  assert.deepEqual(seen, ['good'])
  assert.deepEqual(errors, [{ id: 'bad', message: 'boom' }])
})

test('clearQueue marks queued tasks cancelled through the journal port', async () => {
  const transitions = []
  const lifecycle = createTaskLifecycle({
    journal: { transition: async (id, to, options) => transitions.push({ id, to, options }) },
  })
  lifecycle.enqueue({ id: 'a' })
  lifecycle.enqueue({ id: 'b' })
  assert.equal(await lifecycle.clearQueue('отменено'), 2)
  assert.equal(lifecycle.queue.length, 0)
  assert.deepEqual(transitions.map((entry) => [entry.id, entry.to]), [['a', 'cancelled'], ['b', 'cancelled']])
})

test('awaiting lives in the lifecycle and survives through stateStore', async () => {
  const stateStore = memoryState()
  const lifecycle = createTaskLifecycle({ stateStore })
  await lifecycle.setAwaiting(42, { taskId: 't1', question: 'формат?' })
  assert.equal(lifecycle.awaitingFor(42).taskId, 't1')
  assert.equal(stateStore.get('await:42').question, 'формат?')
  await lifecycle.clearAwaiting(42)
  assert.equal(lifecycle.awaitingFor(42), undefined)
})

test('recovery restores queued tasks, interrupted tasks and open questions', async () => {
  const stateStore = memoryState()
  const updates = []
  const journal = {
    recover: async () => [{ id: 'i1', startedAt: 10 }],
    pending: () => [{ id: 'q1' }, { id: 'q2' }],
    awaiting: () => [{ id: 'a1', chatId: '42', question: 'формат?', updatedAt: 5 }],
    update: async (id, patch) => updates.push({ id, patch }),
  }
  const lifecycle = createTaskLifecycle({
    journal,
    stateStore,
    now: () => 100,
    // lifecycle.recover receives the snapshot port below
  })
  const result = await lifecycle.recover({
    actions: { recover: async () => {} },
    recordToJob: (record) => ({ id: record.id }),
    snapshot: async () => new Map([['outbox/x.docx', { mtimeMs: 20 }], ['old.txt', { mtimeMs: 1 }]]),
    workspaceDir: '/tmp/ws',
  })
  assert.deepEqual(result.pending.map((record) => record.id), ['q1', 'q2'])
  assert.deepEqual(lifecycle.queue.map((job) => job.id), ['q1', 'q2'])
  assert.equal(stateStore.get('await:42').taskId, 'a1')
  assert.deepEqual(updates[0].patch.partialFiles, ['outbox/x.docx'])
})

test('terminal close/update go through the same lifecycle port', async () => {
  const calls = []
  const lifecycle = createTaskLifecycle({
    journal: {
      close: async (...args) => { calls.push(['close', ...args]) },
      update: async (...args) => { calls.push(['update', ...args]) },
    },
  })
  await lifecycle.close('t1', { status: 'done' })
  await lifecycle.update('t1', { verification: { status: 'passed' } })
  assert.equal(calls[0][0], 'close')
  assert.equal(calls[1][0], 'update')
})
