import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequestPoller } from '../src/workflow/request-poller.mjs'
import { createBridgeServer } from '../src/bot-link/bridge-http.mjs'
import { createTestLogger } from './helpers.mjs'

const sha = (c) => c.repeat(40)
const component = { repository: 'tenkrol/agent', changeId: 'PLA-40', baseCommit: sha('a'), specificationCommit: sha('b') }
const manifest = { requestId: 'REQ-0001', revision: 2, components: [component] }
const approval = { requestId: 'REQ-0001', revision: 2, approvedBy: 'owner', approvedAt: '2026-10-18T20:00:00Z', components: [component] }

function poller({ status = { state: 'ready' }, ready = [] } = {}) {
  const git = {
    async clone() {}, async fetchRequests() {},
    async refs() { return ['origin/req/REQ-0001'] },
    async show({ path: file }) {
      if (file.endsWith('manifest.json')) return JSON.stringify(manifest)
      if (file.endsWith('approval.json')) return JSON.stringify(approval)
      if (file.endsWith('status.json')) return JSON.stringify(status)
      throw new Error('ENOENT')
    },
  }
  return createRequestPoller({ git, repo: 'x', dir: '/tmp/x', keyPath: 'k', onReady: async (request) => { ready.push(request); return { queued: true } }, now: () => 1000 })
}

test('poller finds an approved ready request and enqueues it once', async () => {
  const ready = []
  const instance = poller({ ready })
  const result = await instance.scan()
  assert.equal(result.found.length, 1)
  assert.equal(result.enqueued, 1)
  assert.equal(ready[0].requestId, 'REQ-0001')
  assert.equal(ready[0].revision, 2)
  assert.ok(instance.status().nextPollAt > 1000)
})

test('poller skips draft, running and verified requests', async () => {
  for (const status of [{ state: 'draft' }, { state: 'running' }, { state: 'verified' }]) {
    const ready = []
    const result = await poller({ status, ready }).scan()
    assert.equal(result.found.length, 0, JSON.stringify(status))
    assert.equal(ready.length, 0)
  }
})

test('poller reports source errors instead of treating them as no work', async () => {
  const instance = createRequestPoller({
    git: { async clone() { throw new Error('git access denied') } },
    repo: 'x', dir: '/tmp/x', keyPath: 'k', onReady: async () => ({ queued: true }), now: () => 1000,
  })
  await assert.rejects(() => instance.scan(), /access denied/)
  assert.match(instance.status().lastError, /access denied/)
})

test('poll API returns status and can trigger a scan', async () => {
  let scanned = 0
  const server = createBridgeServer({
    token: 'secret', port: 0, logger: createTestLogger(), onSubmit: async () => ({ taskId: 't' }),
    onPoll: async () => { scanned += 1; return { found: [], enqueued: 0 } },
    pollStatus: () => ({ nextPollAt: 42, lastError: undefined }),
  })
  const address = await server.start()
  try {
    const status = await fetch(`http://127.0.0.1:${address.port}/v1/poll/status`, { headers: { authorization: 'Bearer secret' } })
    assert.equal((await status.json()).nextPollAt, 42)
    const poll = await fetch(`http://127.0.0.1:${address.port}/v1/poll`, { method: 'POST', headers: { authorization: 'Bearer secret' } })
    assert.equal(poll.status, 200)
    assert.equal(scanned, 1)
  } finally {
    await server.stop()
  }
})
