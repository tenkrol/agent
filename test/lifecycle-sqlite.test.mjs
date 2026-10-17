/**
 * PLA-20: lifecycle на транзакционной очереди и параллельные workers.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { SqliteTaskQueue } from '../src/storage/sqlite-queue.mjs'
import { createTaskLifecycle } from '../src/orchestration/lifecycle-manager.mjs'

const withQueue = async (fn) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-sqlite-'))
  const queue = new SqliteTaskQueue({ file: path.join(dir, 'queue.db') })
  try {
    await fn(queue, dir)
  } finally {
    queue.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('two workers drain a shared SQLite queue without running a task twice', async () => {
  await withQueue(async (queue) => {
    const journal = { get: () => ({ status: 'done' }) }
    const lifecycle = createTaskLifecycle({ journal, queueStore: queue })
    lifecycle.enqueue({ id: 'a', requestKey: 'a' })
    lifecycle.enqueue({ id: 'b', requestKey: 'b' })
    const seen = []
    await lifecycle.drain({
      workers: 2,
      runTask: async (job) => { seen.push(job.id); await new Promise((resolve) => setTimeout(resolve, 10)) },
    })
    assert.deepEqual(seen.sort(), ['a', 'b'])
    assert.equal(queue.count(), 0)
  })
})

test('recovery imports journal pending tasks into the shared queue', async () => {
  await withQueue(async (queue) => {
    const journal = {
      recover: async () => [],
      pending: () => [{ id: 'q1' }, { id: 'q2' }],
      awaiting: () => [],
    }
    const lifecycle = createTaskLifecycle({ journal, queueStore: queue })
    const result = await lifecycle.recover({
      recordToJob: (record) => ({ id: record.id }),
      snapshot: async () => new Map(),
      workspaceDir: '/tmp',
    })
    assert.equal(result.pending.length, 2)
    assert.equal(queue.count(), 2)
    const first = queue.claim({ owner: 'w1' })
    const second = queue.claim({ owner: 'w2' })
    assert.ok(first)
    assert.ok(second)
    assert.notEqual(first.id, second.id)
    assert.equal(queue.claim({ owner: 'w3' }), undefined, 'третьего захвата нет')
  })
})

test('a parked task leaves the queue as awaiting instead of being re-run', async () => {
  await withQueue(async (queue) => {
    const journal = { get: () => ({ status: 'awaiting_owner' }) }
    const lifecycle = createTaskLifecycle({ journal, queueStore: queue })
    lifecycle.enqueue({ id: 'a', requestKey: 'a' })
    await lifecycle.drain({ runTask: async () => {} })
    assert.equal(queue.count(), 0)
    assert.equal(queue.get('a').status, 'awaiting_owner')
  })
})
