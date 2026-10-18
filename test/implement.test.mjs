import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createImplementService } from '../src/workflow/implement.mjs'

test('implement runs DSH in an isolated checkout and pushes impl branches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'implement-'))
  try {
    const specDir = path.join(root, 'spec')
    await fs.mkdir(path.join(specDir, 'requests', 'REQ-0009'), { recursive: true })
    await fs.writeFile(path.join(specDir, 'requests', 'REQ-0009', 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      requestId: 'REQ-0009',
      revision: 1,
      title: 'Доработка',
      executionPolicy: 'reviewed',
      releasePolicy: 'manual',
      components: [{ repository: 'tenkrol/agent', changeId: 'PLA-99', baseCommit: 'a'.repeat(40), specificationCommit: 'b'.repeat(40), branch: 'spec/REQ-0009-PLA-99' }],
    }))
    await fs.writeFile(path.join(specDir, 'requests', 'REQ-0009', 'request.md'), '# REQ-0009\n\nСделай доработку')
    const calls = []
    const service = createImplementService({
      baseDir: path.join(root, 'work'),
      timeoutMs: 1000,
      components: [{ repository: 'tenkrol/agent', keyPath: '/tmp/key' }],
      logger: { info() {} },
      git: {
        async clone(options) { calls.push({ kind: 'clone', ...options }); return { dir: options.dir, sha: 'a'.repeat(40) } },
        async commitAndPush(options) { calls.push({ kind: 'push', ...options }); return { sha: 'c'.repeat(40), compareUrl: 'https://example/compare' } },
      },
      runner: { async run(input) { calls.push({ kind: 'run', ...input }); return { ok: true, text: 'готово', usage: { steps: 2, totalTokens: 5 } } } },
    })
    const result = await service.implement({ requestId: 'REQ-0009', specRepo: 'tenkrol/assistant-work', specDir, keyPath: '/tmp/key' })
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].branch, 'impl/REQ-0009-PLA-99')
    const run = calls.find((call) => call.kind === 'run')
    assert.match(run.task, /REQ-0009/)
    assert.match(run.workspaceDir, /REQ-0009\/agent$/)
    assert.equal(run.maxSteps, 80)
    assert.equal(run.tokenBudget, 800000)
    assert.ok(calls.some((call) => call.kind === 'push' && call.branch === 'impl/REQ-0009-PLA-99'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a failed DSH run does not push an impl branch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'implement-'))
  try {
    const specDir = path.join(root, 'spec')
    await fs.mkdir(path.join(specDir, 'requests', 'REQ-0010'), { recursive: true })
    await fs.writeFile(path.join(specDir, 'requests', 'REQ-0010', 'manifest.json'), JSON.stringify({
      components: [{ repository: 'tenkrol/agent', changeId: 'PLA-99', branch: 'spec/REQ-0010-PLA-99', specificationCommit: 'b'.repeat(40) }],
    }))
    await fs.writeFile(path.join(specDir, 'requests', 'REQ-0010', 'request.md'), '# REQ-0010')
    const pushes = []
    const service = createImplementService({
      baseDir: path.join(root, 'work'),
      components: [{ repository: 'tenkrol/agent', keyPath: '/tmp/key' }],
      git: {
        async clone(options) { return { dir: options.dir, sha: 'a'.repeat(40) } },
        async commitAndPush(options) { pushes.push(options); return { sha: 'c'.repeat(40), compareUrl: 'x' } },
      },
      runner: { async run() { return { ok: false, text: 'провал' } } },
    })
    await assert.rejects(() => service.implement({ requestId: 'REQ-0010', specRepo: 'x', specDir, keyPath: '/tmp/key' }), /DSH/)
    assert.equal(pushes.length, 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('POST /v1/implement validates requestId and calls the service', async () => {
  const { createBridgeServer } = await import('../src/bot-link/bridge-http.mjs')
  const { createTestLogger } = await import('./helpers.mjs')
  const seen = []
  const server = createBridgeServer({
    token: 'secret',
    port: 0,
    logger: createTestLogger(),
    onSubmit: async () => ({ taskId: 't' }),
    onImplement: async ({ requestId }) => { seen.push(requestId); return { requestId, results: [] } },
  })
  const address = await server.start()
  try {
    const bad = await fetch(`http://127.0.0.1:${address.port}/v1/implement`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'nope' }),
    })
    assert.equal(bad.status, 400)
    const ok = await fetch(`http://127.0.0.1:${address.port}/v1/implement`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'REQ-0009' }),
    })
    assert.equal(ok.status, 202)
    assert.deepEqual(seen, ['REQ-0009'])
  } finally {
    await server.stop()
  }
})
