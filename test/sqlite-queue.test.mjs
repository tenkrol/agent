/**
 * Примитивы транзакционной очереди (PLA-20): аренда, поколение, восстановление.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { SqliteTaskQueue } from '../src/storage/sqlite-queue.mjs'

const withQueue = async (fn) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-test-'))
  const queue = new SqliteTaskQueue({ file: path.join(dir, 'queue.db') })
  try {
    await fn(queue)
  } finally {
    queue.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('two claimants get exactly one task and a repeated request returns the same task', async () => {
  await withQueue(async (queue) => {
    const first = queue.enqueue({ id: 't1', requestKey: 'r1', payload: { text: 'x' }, now: 1000 })
    const again = queue.enqueue({ id: 't2', requestKey: 'r1', payload: { text: 'y' }, now: 1001 })
    assert.equal(first.id, 't1')
    assert.equal(again.id, 't1')

    const one = queue.claim({ owner: 'w1', ttlMs: 60_000, now: 2000 })
    assert.equal(one.id, 't1')
    assert.equal(one.generation, 1)
    const two = queue.claim({ owner: 'w2', ttlMs: 60_000, now: 2000 })
    assert.equal(two, undefined)
  })
})

test('heartbeat extends the lease and only the owning attempt can complete', async () => {
  await withQueue(async (queue) => {
    queue.enqueue({ id: 't1', now: 1000 })
    const claim = queue.claim({ owner: 'w1', ttlMs: 100, now: 1000 })
    assert.equal(queue.heartbeat({ taskId: 't1', generation: claim.generation, owner: 'w1', ttlMs: 1000, now: 1050 }), true)
    assert.equal(queue.heartbeat({ taskId: 't1', generation: claim.generation, owner: 'w2', ttlMs: 1000, now: 1050 }), false)
    assert.deepEqual(queue.complete({ taskId: 't1', generation: claim.generation + 1, owner: 'w1', status: 'done', now: 1100 }), { ok: false, stale: true })
    assert.deepEqual(queue.complete({ taskId: 't1', generation: claim.generation, owner: 'w1', status: 'done', now: 1100 }), { ok: true, stale: false })
    assert.equal(queue.get('t1').status, 'done')
  })
})

test('an expired lease is recovered and the old generation cannot finish', async () => {
  await withQueue(async (queue) => {
    queue.enqueue({ id: 't1', now: 1000 })
    const first = queue.claim({ owner: 'w1', ttlMs: 50, now: 1000 })
    const second = queue.claim({ owner: 'w2', ttlMs: 100, now: 2000 })
    assert.equal(second.id, 't1')
    assert.equal(second.generation, first.generation + 1)
    assert.equal(queue.complete({ taskId: 't1', generation: first.generation, owner: 'w1', status: 'failed', now: 2100 }).stale, true)
    assert.equal(queue.get('t1').status, 'running')
    assert.equal(queue.complete({ taskId: 't1', generation: second.generation, owner: 'w2', status: 'done', now: 2100 }).ok, true)
  })
})

test('recoverExpired requeues a lost attempt and marks it lost', async () => {
  await withQueue(async (queue) => {
    queue.enqueue({ id: 't1', now: 1000 })
    const claim = queue.claim({ owner: 'w1', ttlMs: 10, now: 1000 })
    assert.equal(queue.recoverExpired({ now: 2000 }), 1)
    assert.equal(queue.get('t1').status, 'queued')
    const attempt = queue.attempts('t1').find((row) => row.generation === claim.generation)
    assert.equal(attempt.status, 'lost')
    const next = queue.claim({ owner: 'w2', now: 2000 })
    assert.equal(next.generation, claim.generation + 1)
  })
})

test('requeue returns an awaiting task to queued with new payload and generation', async () => {
  await withQueue(async (queue) => {
    queue.enqueue({ id: 't1', requestKey: 'r1', payload: { text: 'old' }, now: 1000 })
    const first = queue.claim({ owner: 'w1', ttlMs: 1000, now: 1000 })
    assert.equal(queue.setStatus({ taskId: 't1', generation: first.generation, owner: 'w1', status: 'awaiting_owner', now: 1100 }), true)
    assert.equal(queue.claim({ owner: 'w2', now: 1200 }), undefined, 'awaiting не выдаётся')
    const requeued = queue.requeue({ taskId: 't1', payload: { text: 'new' }, now: 1300 })
    assert.equal(requeued.ok, true)
    assert.equal(requeued.generation, first.generation + 1)
    const second = queue.claim({ owner: 'w2', ttlMs: 1000, now: 1400 })
    assert.equal(second.id, 't1')
    assert.deepEqual(second.payload, { text: 'new' })
    assert.equal(queue.complete({ taskId: 't1', generation: first.generation, owner: 'w1', status: 'done', now: 1500 }).stale, true)
    assert.equal(queue.complete({ taskId: 't1', generation: second.generation, owner: 'w2', status: 'done', now: 1500 }).ok, true)
    assert.equal(queue.complete({ taskId: 't1', generation: second.generation, owner: 'w2', status: 'done', now: 1500 }).stale, true, 'повторный terminal запрещён')
  })
})

test('cancelAll removes queued tasks from claim', async () => {
  await withQueue(async (queue) => {
    queue.enqueue({ id: 'a', now: 1000 })
    queue.enqueue({ id: 'b', now: 1000 })
    assert.equal(queue.cancelAll({ now: 1100 }), 2)
    assert.equal(queue.claim({ owner: 'w1', now: 1200 }), undefined)
    assert.equal(queue.get('a').status, 'cancelled')
  })
})

test('a stale attempt cannot complete after lease recovery', async () => {
  await withQueue(async (queue) => {
    queue.enqueue({ id: 't1', now: 1000 })
    const old = queue.claim({ owner: 'w1', ttlMs: 10, now: 1000 })
    assert.equal(queue.recoverExpired({ now: 2000 }), 1)
    assert.equal(queue.complete({ taskId: 't1', generation: old.generation, owner: 'w1', status: 'done', now: 2000 }).stale, true)
    const fresh = queue.claim({ owner: 'w2', ttlMs: 1000, now: 2000 })
    assert.ok(fresh)
    assert.equal(queue.complete({ taskId: 't1', generation: old.generation, owner: 'w1', status: 'done', now: 2000 }).stale, true)
    assert.equal(queue.complete({ taskId: 't1', generation: fresh.generation, owner: 'w2', status: 'done', now: 2100 }).ok, true)
  })
})

test('queued tasks survive closing and reopening the SQLite file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'queue-reopen-'))
  const file = path.join(dir, 'queue.db')
  try {
    const first = new SqliteTaskQueue({ file })
    first.enqueue({ id: 'a', requestKey: 'a', payload: { text: 'x' } })
    first.close()
    const second = new SqliteTaskQueue({ file })
    const claim = second.claim({ owner: 'w1' })
    assert.equal(claim.id, 'a')
    assert.equal(claim.payload.text, 'x')
    second.close()
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('accept commits terminal status and outbox atomically', async () => {
  await withQueue(async (queue) => {
    queue.enqueue({ id: 't1', payload: { id: 't1' }, now: 1000 })
    const claim = queue.claim({ owner: 'w1', ttlMs: 10_000, now: 1000 })
    const accepted = queue.accept({
      taskId: 't1', generation: claim.generation, owner: 'w1', status: 'done',
      payload: { accepted: true },
      outbox: { eventId: 't1:result:1', event: { eventId: 't1:result:1', text: 'ok' } },
      now: 1100,
    })
    assert.equal(accepted.ok, true)
    assert.equal(queue.get('t1').status, 'done')
    const pending = queue.pendingOutbox()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].event_id, 't1:result:1')
    assert.equal(queue.markOutboxEnqueued('t1:result:1'), true)
    assert.equal(queue.pendingOutbox().length, 0)
  })
})

test('accept after lease recovery is stale and writes no outbox', async () => {
  await withQueue(async (queue) => {
    queue.enqueue({ id: 't1', now: 1000 })
    const old = queue.claim({ owner: 'w1', ttlMs: 10, now: 1000 })
    queue.recoverExpired({ now: 2000 })
    const accepted = queue.accept({ taskId: 't1', generation: old.generation, owner: 'w1', status: 'done', outbox: { eventId: 'e', event: {} }, now: 2000 })
    assert.equal(accepted.ok, false)
    assert.equal(accepted.stale, true)
    assert.equal(queue.pendingOutbox().length, 0)
  })
})
