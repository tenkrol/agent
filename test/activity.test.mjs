/**
 * E2: журнал активности и API /v1/agents, /v1/activity.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ActivityStore } from '../src/storage/activity.mjs'
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
