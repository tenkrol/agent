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

test('parallel workers are rejected and one worker drains the queue once', async () => {
  await withQueue(async (queue) => {
    const journal = { get: () => ({ status: 'done' }) }
    const lifecycle = createTaskLifecycle({ journal, queueStore: queue })
    lifecycle.enqueue({ id: 'a', requestKey: 'a' })
    lifecycle.enqueue({ id: 'b', requestKey: 'b' })
    const seen = []
    await assert.rejects(() => lifecycle.drain({ workers: 2, runTask: async () => {} }), /изолированного|запрещён/)
    await lifecycle.drain({
      workers: 1,
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

test('clearQueue cancels queued SQLite tasks so claim cannot return them', async () => {
  await withQueue(async (queue) => {
    const transitions = []
    const journal = { transition: async (id, to) => transitions.push({ id, to }) }
    const lifecycle = createTaskLifecycle({ journal, queueStore: queue })
    lifecycle.enqueue({ id: 'a', requestKey: 'a' })
    lifecycle.enqueue({ id: 'b', requestKey: 'b' })
    assert.equal(await lifecycle.clearQueue('отменено'), 2)
    assert.equal(queue.claim({ owner: 'w1' }), undefined)
    assert.equal(transitions.length, 2)
  })
})

test('a crashed running lease is recovered without a new request after TTL', async () => {
  await withQueue(async (queue) => {
    queue.enqueue({ id: 'a', requestKey: 'a', payload: { id: 'a' } })
    queue.claim({ owner: 'dead', ttlMs: 40 })
    const lifecycle = createTaskLifecycle({ journal: { get: () => ({ status: 'done' }), recover: async () => [], pending: () => [], awaiting: () => [] }, queueStore: queue })
    let runs = 0
    await lifecycle.recover({ recordToJob: (record) => ({ id: record.id }), snapshot: async () => new Map(), workspaceDir: '/tmp' })
    await lifecycle.drain({ runTask: async () => { runs += 1 } })
    assert.equal(runs, 1, 'задача выполнена после истечения аренды без нового запроса')
    assert.equal(queue.get('a').status, 'done')
  })
})

test('recovery requeues the journal record of a crashed running lease', async () => {
  await withQueue(async (queue) => {
    queue.enqueue({ id: 'a', requestKey: 'a', payload: { id: 'a' } })
    queue.claim({ owner: 'dead', ttlMs: 20 })
    const requeued = []
    const journal = {
      recover: async () => [{ id: 'a' }],
      pending: () => [],
      awaiting: () => [],
      requeue: async (id, options) => requeued.push({ id, options }),
    }
    const lifecycle = createTaskLifecycle({ journal, queueStore: queue })
    await lifecycle.recover({ recordToJob: (record) => ({ id: record.id }), snapshot: async () => new Map(), workspaceDir: '/tmp' })
    assert.equal(requeued.length, 1)
    assert.equal(requeued[0].id, 'a')
    assert.match(requeued[0].options.reason, /аренд/)
    assert.equal(lifecycle.queue.some((job) => job.id === 'a'), true)
  })
})

test('recovery reconciles a terminal SQLite result with a stale JSONL record', async () => {
  await withQueue(async (queue) => {
    queue.enqueue({ id: 'a', requestKey: 'a', payload: { id: 'a' } })
    const claim = queue.claim({ owner: 'w1', ttlMs: 60_000 })
    queue.complete({ taskId: 'a', generation: claim.generation, owner: 'w1', status: 'done' })
    const closed = []
    const journal = {
      recover: async () => [],
      pending: () => [],
      awaiting: () => [],
      recent: () => [{ id: 'a', status: 'running' }],
      close: async (id, patch) => closed.push({ id, patch }),
    }
    const lifecycle = createTaskLifecycle({ journal, queueStore: queue })
    await lifecycle.recover({ recordToJob: (record) => ({ id: record.id }), snapshot: async () => new Map(), workspaceDir: '/tmp' })
    assert.equal(closed.length, 1)
    assert.equal(closed[0].id, 'a')
    assert.equal(closed[0].patch.status, 'done')
  })
})

test('accept boundary marks the lease task done and stores outbox before delivery', async () => {
  await withQueue(async (queue) => {
    const journal = { get: () => ({ status: 'done' }) }
    const lifecycle = createTaskLifecycle({ journal, queueStore: queue })
    lifecycle.enqueue({ id: 'a', requestKey: 'a', payload: { id: 'a' } })
    await lifecycle.drain({
      runTask: async (job, context) => {
        const result = context.accept({
          status: 'done',
          payload: { accepted: true },
          outbox: { eventId: 'a:result:1', event: { eventId: 'a:result:1' } },
        })
        assert.equal(result.ok, true)
      },
    })
    assert.equal(queue.get('a').status, 'done')
    assert.equal(queue.pendingOutbox().length, 1)
  })
})

test('park atomically moves a task to awaiting_owner before the question is sent', async () => {
  await withQueue(async (queue) => {
    const journal = { get: () => ({ status: 'awaiting_owner' }) }
    const lifecycle = createTaskLifecycle({ journal, queueStore: queue })
    lifecycle.enqueue({ id: 'a', requestKey: 'a', payload: { id: 'a' } })
    await lifecycle.drain({
      runTask: async (job, context) => {
        const result = context.park({ payload: { question: 'формат?' }, outbox: null })
        assert.equal(result.ok, true)
      },
    })
    assert.equal(queue.get('a').status, 'awaiting_owner')
    assert.equal(queue.claim({ owner: 'w2' }), undefined)
  })
})

test('recovery requeues journal awaiting when SQLite already returned it to queued', async () => {
  await withQueue(async (queue) => {
    queue.enqueue({ id: 'a', requestKey: 'a', payload: { id: 'a' } })
    const requeued = []
    const journal = {
      recover: async () => [],
      pending: () => [],
      awaiting: () => [],
      get: () => ({ status: 'awaiting_owner' }),
      requeue: async (id, options) => requeued.push({ id, options }),
    }
    const lifecycle = createTaskLifecycle({ journal, queueStore: queue })
    await lifecycle.recover({ recordToJob: (record) => ({ id: record.id }), snapshot: async () => new Map(), workspaceDir: '/tmp' })
    assert.equal(requeued.length, 1)
    assert.equal(requeued[0].id, 'a')
    assert.equal(queue.get('a').status, 'queued')
  })
})

test('a stale attempt is aborted and does not call onError after losing its lease', async () => {
  await withQueue(async (queue) => {
    const lifecycle = createTaskLifecycle({ journal: { get: () => ({ status: 'running' }) }, queueStore: queue })
    lifecycle.enqueue({ id: 'a', requestKey: 'a', payload: { id: 'a' } })
    let errors = 0
    let aborted = false
    await lifecycle.drain({
      leaseTtlMs: 20,
      runTask: async (job, context) => {
        await new Promise((resolve) => {
          if (context.leaseSignal.aborted) resolve()
          else context.leaseSignal.addEventListener('abort', resolve, { once: true })
        })
        aborted = context.leaseSignal.aborted
        throw new Error('lost lease')
      },
      onError: async () => { errors += 1 },
    })
    assert.equal(aborted, true)
    assert.equal(errors, 0, 'onError не вызывается у stale-попытки')
  })
})
