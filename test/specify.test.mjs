import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createSpecifyService } from '../src/workflow/specify.mjs'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'specify-'))
  const specDir = path.join(root, 'spec')
  await fs.mkdir(path.join(specDir, 'requests', 'REQ-1'), { recursive: true })
  await fs.mkdir(path.join(specDir, 'requests', 'REQ-2'), { recursive: true })
  await fs.writeFile(path.join(specDir, 'requests', 'REQ-1', 'manifest.json'), JSON.stringify({ requestId: 'REQ-1', revision: 1, components: [{ repository: 'tenkrol/agent', changeId: 'PLA-99', baseCommit: SHA_A, specificationCommit: SHA_B, branch: 'spec/REQ-1-PLA-99' }] }))
  const calls = []
  const git = {
    async clone(options) { calls.push({ kind: 'clone', ...options }); return { sha: SHA_B } },
    async commitAndPush(options) { calls.push({ kind: 'push', ...options }); return { sha: SHA_C, compareUrl: 'x' } },
  }
  const service = createSpecifyService({
    components: [{ repository: 'tenkrol/agent', keyPath: '/k', specChecks: [] }],
    git,
    runner: { async run(input) { calls.push({ kind: 'run', ...input }); return { ok: true, usage: { totalTokens: 10 } } } },
    baseDir: path.join(root, 'work'),
    timeoutMs: 1000,
    loadRequest: async () => ({
      manifest: { requestId: 'REQ-1', revision: 1, components: [{ repository: 'tenkrol/agent', changeId: 'PLA-99', baseCommit: SHA_A, specificationCommit: SHA_B, branch: 'spec/REQ-1-PLA-99' }] },
      text: '# REQ-1\n\nДобавь поведение',
      status: { state: 'draft' },
    }),
  })
  return { root, specDir, service, calls }
}

test('specify runs DSH research, publishes spec branch and marks ready', async () => {
  const ctx = await setup()
  try {
    const result = await ctx.service.specify({ requestId: 'REQ-1', specRepo: 'spec', specDir: ctx.specDir, keyPath: '/k' })
    assert.equal(result.state, 'ready')
    const run = ctx.calls.find((call) => call.kind === 'run')
    assert.match(run.task, /инженерную спецификацию/)
    assert.match(run.task, /questions\.md/)
    const status = JSON.parse(await fs.readFile(path.join(ctx.specDir, 'requests', 'REQ-1', 'status.json'), 'utf8'))
    assert.equal(status.state, 'ready')
    assert.equal(status.specs[0].changeId, 'PLA-99')
    const manifest = JSON.parse(await fs.readFile(path.join(ctx.specDir, 'requests', 'REQ-1', 'manifest.json'), 'utf8'))
    assert.equal(manifest.components[0].specificationCommit, SHA_C, 'manifest ссылается на ready SHA')
  } finally {
    await fs.rm(ctx.root, { recursive: true, force: true })
  }
})

test('a failed DSH research does not mark the request ready', async () => {
  const ctx = await setup()
  try {
    ctx.service = createSpecifyService({
      components: [{ repository: 'tenkrol/agent', keyPath: '/k' }],
      git: { async clone() { return {} }, async commitAndPush() { return {} } },
      runner: { async run() { return { ok: false, text: 'fail' } } },
      baseDir: '/tmp/work', timeoutMs: 1000, loadRequest: async () => ({ manifest: { requestId: 'REQ-2', revision: 1, components: [{ repository: 'tenkrol/agent', changeId: 'PLA-99', baseCommit: SHA_A, specificationCommit: SHA_B, branch: 's' }] }, text: 'x', status: { state: 'draft' } }),
    })
    await assert.rejects(() => ctx.service.specify({ requestId: 'REQ-2', specRepo: 'spec', specDir: ctx.specDir, keyPath: '/k' }), /DSH/)
    await assert.rejects(() => fs.stat(path.join(ctx.specDir, 'requests', 'REQ-2', 'status.json')))
  } finally {
    await fs.rm(ctx.root, { recursive: true, force: true })
  }
})
