import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createObserverRegistry, createGithubSource, createServerSource } from '../src/workflow/observers.mjs'

test('unavailable source is explicit, not an empty result', async () => {
  const registry = createObserverRegistry({
    now: () => 1000,
    sources: [
      { id: 'github', kind: 'github', async read() { throw new Error('access denied') } },
      createServerSource({ id: 'server', probe: async () => ({ disk: 10 }) }),
    ],
  })
  const report = await registry.observe()
  assert.equal(report.sources[0].status, 'unavailable')
  assert.match(report.sources[0].error, /access denied/)
  assert.equal(report.sources[1].status, 'ok')
  assert.deepEqual(report.sources[1].evidence, { disk: 10 })
})

test('findings appear only when evidence changes', async () => {
  let value = 1
  const registry = createObserverRegistry({ now: () => 1000, sources: [createServerSource({ probe: async () => ({ value }) })] })
  const first = await registry.observe()
  assert.equal(first.findings.length, 0)
  value = 2
  const second = await registry.observe()
  assert.equal(second.findings.length, 1)
  assert.equal(second.findings[0].evidence.value, 2)
})

test('github source reads HEAD through the git client', async () => {
  const calls = []
  const source = createGithubSource({
    git: {
      async clone(options) { calls.push(options) },
      async head() { return 'a'.repeat(40) },
    },
    repos: ['tenkrol/agent'],
    dirRoot: '/tmp/obs',
  })
  assert.deepEqual(await source.fetch(), [{ repo: 'tenkrol/agent', sha: 'a'.repeat(40) }])
  assert.equal(calls[0].branch, 'main')
})

test('observer API lists sources and runs a scan', async () => {
  const { createBridgeServer } = await import('../src/bot-link/bridge-http.mjs')
  const { createTestLogger } = await import('./helpers.mjs')
  const server = createBridgeServer({
    token: 'secret', port: 0, logger: createTestLogger(), onSubmit: async () => ({ taskId: 't' }),
    observers: () => [{ id: 'github', kind: 'github' }],
    onObserve: async () => ({ sources: [], findings: [] }),
  })
  const address = await server.start()
  try {
    const list = await fetch(`http://127.0.0.1:${address.port}/v1/observers`, { headers: { authorization: 'Bearer secret' } })
    assert.deepEqual((await list.json()).sources[0].id, 'github')
    const scan = await fetch(`http://127.0.0.1:${address.port}/v1/observe`, { method: 'POST', headers: { authorization: 'Bearer secret' } })
    assert.equal(scan.status, 200)
  } finally {
    await server.stop()
  }
})
