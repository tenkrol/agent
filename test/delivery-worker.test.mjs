/**
 * Воркер доставки: отдельное состояние, постоянный eventId, ack, повторы.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { DeliveryStore, DELIVERY } from '../src/storage/deliveries.mjs'
import { DeliveryWorker } from '../src/bot-link/deliver.mjs'
import { cleanup, createStubPlatform, createTestLogger, tempDir } from './helpers.mjs'

const event = (taskId = 't1') => ({
  contract: 2,
  eventId: `${taskId}:result:1`,
  taskId,
  type: 'result',
  route: { platform: 'telegram', botId: '999', chatId: '42' },
  text: 'готово',
  title: 'Ответ агента',
})

const reply = (body, { ok = true, status = 200 } = {}) => Promise.resolve({
  ok,
  status,
  json: async () => body,
})

test('an ack stops repeats, the same eventId is used for a retry', async () => {
  const dir = await tempDir()
  try {
    const store = await new DeliveryStore({ file: path.join(dir, 'deliveries.jsonl'), logger: createTestLogger() }).load()
    const calls = []
    let answer = reply({ ok: false, processed: false }, { ok: false, status: 500 })
    const worker = new DeliveryWorker({
      store,
      platform: createStubPlatform(),
      outbox: { url: 'http://outbox', token: 't' },
      logger: createTestLogger(),
      fetchImpl: async (url, options) => {
        calls.push(JSON.parse(options.body))
        return answer
      },
      retryMs: [1],
      maxAttempts: 3,
    })
    const first = await worker.enqueue(event())
    assert.equal(first.state, DELIVERY.pending)
    assert.equal(first.attempts, 1)

    answer = reply({ ok: true, eventId: 't1:result:1', processed: true, duplicate: false })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await worker.tick()
    const updated = store.get('t1:result:1')
    assert.equal(updated.state, DELIVERY.acked)
    assert.equal(updated.outcome, 'acked')
    assert.equal(calls.length, 2)
    assert.equal(calls[0].eventId, calls[1].eventId)
  } finally {
    await cleanup(dir)
  }
})

test('a legacy receiver gets the text once and is not retried', async () => {
  const dir = await tempDir()
  try {
    const store = await new DeliveryStore({ file: path.join(dir, 'deliveries.jsonl'), logger: createTestLogger() }).load()
    const worker = new DeliveryWorker({
      store,
      platform: createStubPlatform(),
      outbox: { url: 'http://outbox', token: 't' },
      logger: createTestLogger(),
      fetchImpl: async () => reply({ ok: true }),
      retryMs: [1],
      maxAttempts: 3,
    })
    await worker.enqueue(event())
    const record = store.get('t1:result:1')
    assert.equal(record.state, DELIVERY.sent)
    assert.equal(record.outcome, 'sent')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await worker.tick()
    assert.equal(store.get('t1:result:1').attempts, 1, 'повтора нет без подтверждения')
  } finally {
    await cleanup(dir)
  }
})

test('4xx is terminal and failure notifies the owner channel', async () => {
  const dir = await tempDir()
  try {
    const store = await new DeliveryStore({ file: path.join(dir, 'deliveries.jsonl'), logger: createTestLogger() }).load()
    const failures = []
    const worker = new DeliveryWorker({
      store,
      platform: createStubPlatform(),
      outbox: { url: 'http://outbox', token: 't' },
      logger: createTestLogger(),
      onFailed: async (record) => failures.push(record.eventId),
      fetchImpl: async () => reply({ ok: false, error: 'bad' }, { ok: false, status: 400 }),
    })
    await worker.enqueue(event())
    assert.equal(store.get('t1:result:1').state, DELIVERY.failed)
    assert.deepEqual(failures, ['t1:result:1'])
  } finally {
    await cleanup(dir)
  }
})

test('a sending record recovered after restart is not stuck', async () => {
  const dir = await tempDir()
  try {
    const store = await new DeliveryStore({ file: path.join(dir, 'deliveries.jsonl'), logger: createTestLogger() }).load()
    await store.create(event())
    await store.sending('t1:result:1')
    const recovered = await store.recoverSending()
    assert.equal(recovered, 1)
    const record = store.get('t1:result:1')
    assert.equal(record.state, DELIVERY.sent)
    assert.equal(record.outcome, 'unknown')
    assert.ok(record.nextAttemptAt <= Date.now())
  } finally {
    await cleanup(dir)
  }
})

test('personal delivery is tracked separately and acked by message id', async () => {
  const dir = await tempDir()
  try {
    const store = await new DeliveryStore({ file: path.join(dir, 'deliveries.jsonl'), logger: createTestLogger() }).load()
    const platform = createStubPlatform()
    const worker = new DeliveryWorker({
      store,
      platform,
      outbox: { url: 'http://outbox', token: 't' },
      logger: createTestLogger(),
      fetchImpl: async () => reply({ processed: true }),
    })
    await worker.enqueue({
      contract: 2,
      eventId: 't1:personal:1',
      taskId: 't1',
      type: 'result',
      chatId: 42,
      text: 'личное сообщение',
    }, { channel: 'personal' })
    const record = store.get('t1:personal:1')
    assert.equal(record.channel, 'personal')
    assert.equal(record.state, DELIVERY.acked)
    assert.equal(platform.sent.length, 1)
    assert.equal(platform.sent[0].markdown, 'личное сообщение')
  } finally {
    await cleanup(dir)
  }
})
