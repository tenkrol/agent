/**
 * E2: журнал активности и API /v1/agents, /v1/activity.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ActivityStore } from '../src/storage/activity.mjs'
import { AgentBot } from '../src/core/bot.mjs'
import { createBridgeServer } from '../src/bot-link/bridge-http.mjs'
import { createTestLogger } from './helpers.mjs'

test('activity store keeps bounded recent events and filters', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'activity-'))
  const file = path.join(dir, 'activity.jsonl')
  try {
    const store = new ActivityStore({ file, maxEntries: 3, logger: createTestLogger() })
    await store.load()
    for (let index = 0; index < 5; index++) {
      store.record({ type: 'test', taskId: `t${index}`, agent: index % 2 ? 'dsh' : 'quick' })
    }
    await store.flush()
    assert.equal(store.recent({ limit: 10 }).length, 3)
    assert.ok(store.recent({ agent: 'dsh' }).every((event) => event.agent === 'dsh'))
    assert.deepEqual(store.recent({ taskId: 't4' }).map((event) => event.taskId), ['t4'])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('GET /v1/agents and /v1/activity require the token and return data', async () => {
  const server = createBridgeServer({
    token: 'secret',
    port: 0,
    logger: createTestLogger(),
    onSubmit: async () => ({ taskId: 'x' }),
    agents: () => [{ id: 'dsh', capabilities: ['code'] }],
    activity: ({ limit }) => [{ type: 'completed', taskId: 't1' }].slice(0, limit),
  })
  const address = await server.start()
  const url = `http://127.0.0.1:${address.port}`
  try {
    assert.equal((await fetch(`${url}/v1/agents`)).status, 401)
    const agents = await fetch(`${url}/v1/agents`, { headers: { authorization: 'Bearer secret' } })
    assert.equal(agents.status, 200)
    assert.deepEqual((await agents.json()).agents, [{ id: 'dsh', capabilities: ['code'] }])
    const activity = await fetch(`${url}/v1/activity?limit=5`, { headers: { authorization: 'Bearer secret' } })
    assert.equal(activity.status, 200)
    assert.equal((await activity.json()).events[0].taskId, 't1')
  } finally {
    await server.stop()
  }
})

test('событие задачи несёт владельца и область из проверенного job, а не из текста', async () => {
  const recorded = []
  const host = { activity: { record: (event) => { recorded.push(event); return event } } }
  AgentBot.prototype.recordActivity.call(
    host,
    { id: 't1', userId: 433296567, chatId: 433296567 },
    { type: 'completed', status: 'done' },
  )
  assert.deepEqual(recorded[0], {
    taskId: 't1',
    userId: 433296567,
    scopeId: '433296567',
    type: 'completed',
    status: 'done',
  })

  // Без проверенного userId событие не получает владельца и остаётся
  // кандидатом на фильтр «у задачи нет проверенного владельца».
  AgentBot.prototype.recordActivity.call(host, { id: 't2', chatId: 1 }, { type: 'completed', taskId: 't2' })
  assert.equal(recorded[1].userId, undefined)
  assert.equal(recorded[1].scopeId, '1')
})

test('GET /v1/activity отдаёт userId и scopeId задачи', async () => {
  const server = createBridgeServer({
    token: 'secret',
    port: 0,
    logger: createTestLogger(),
    onSubmit: async () => ({ taskId: 'x' }),
    activity: () => [{
      type: 'completed',
      taskId: 't1',
      userId: 433296567,
      scopeId: '433296567',
    }],
  })
  const address = await server.start()
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/activity`, {
      headers: { authorization: 'Bearer secret' },
    })
    assert.equal(response.status, 200)
    const [event] = (await response.json()).events
    assert.equal(event.userId, 433296567)
    assert.equal(event.scopeId, '433296567')
  } finally {
    await server.stop()
  }
})
