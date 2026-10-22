import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createImplementService } from '../src/workflow/implement.mjs'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

async function setup({ requestId = 'REQ-0009', approval = true, status = 'ready', manifestOverrides = {}, componentOverrides = {}, approvalOverrides } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'implement-'))
  const specDir = path.join(root, 'spec')
  const dir = path.join(specDir, 'requests', requestId)
  await fs.mkdir(dir, { recursive: true })
  const component = {
    repository: 'tenkrol/agent',
    changeId: 'PLA-99',
    baseCommit: SHA_A,
    specificationCommit: SHA_B,
    branch: `spec/${requestId}-PLA-99`,
    ...componentOverrides,
  }
  const manifest = {
    schemaVersion: 1,
    requestId,
    revision: 1,
    title: 'Доработка',
    executionPolicy: 'reviewed',
    releasePolicy: 'manual',
    components: [component],
    ...manifestOverrides,
  }
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  await fs.writeFile(path.join(dir, 'request.md'), `# ${requestId}\n\nСделай доработку`)
  if (approval) {
    await fs.writeFile(path.join(dir, 'approval.json'), JSON.stringify({
      requestId,
      revision: 1,
      approvedBy: 'owner',
      approvedAt: '2026-10-18T20:00:00.000Z',
      components: [approvalOverrides ?? component],
    }))
  }
  if (status) await fs.writeFile(path.join(dir, 'status.json'), JSON.stringify({ requestId, state: status, revision: 1 }))
  const calls = []
  const git = {
    async clone(options) { calls.push({ kind: 'clone', ...options }); return { dir: options.dir, sha: SHA_A } },
    async checkoutCommit(options) { calls.push({ kind: 'checkout', ...options }); return options.sha },
    async commitAndPush(options) { calls.push({ kind: 'push', ...options }); return { sha: SHA_C, compareUrl: 'https://example/compare' } },
    async head() { return SHA_B },
  }
  return { root, specDir, dir, manifest, component, calls, git }
}

const service = (git, runner, extra = {}) => createImplementService({
  baseDir: '/tmp/work',
  timeoutMs: 1000,
  components: [{ repository: 'tenkrol/agent', keyPath: '/tmp/key', checks: [['node', '--test']] }],
  logger: { info() {} },
  git,
  runner,
  ...extra,
})

test('ready+approved request runs DSH at the approved specification commit and publishes impl', async () => {
  const ctx = await setup()
  try {
    const calls = []
    const impl = service(ctx.git, { async run(input) { calls.push(input); return { ok: true, text: 'готово', usage: { steps: 2, totalTokens: 5 } } } }, {
      runChecks: async () => ({ checks: [{ command: 'node --test', exitCode: 0 }] }),
    })
    const result = await impl.implement({ requestId: 'REQ-0009', specRepo: 'tenkrol/assistant-work', specDir: ctx.specDir, keyPath: '/tmp/key' })
    assert.equal(result.state, 'verified')
    assert.equal(result.results[0].branch, 'impl/REQ-0009-PLA-99')
    assert.ok(ctx.calls.some((call) => call.kind === 'checkout' && call.sha === SHA_B), 'checkout по specificationCommit')
    assert.equal(calls.length, 1)
    assert.match(calls[0].task, /REQ-0009/)
    const status = JSON.parse(await fs.readFile(path.join(ctx.dir, 'status.json'), 'utf8'))
    assert.equal(status.state, 'verified')
  } finally {
    await fs.rm(ctx.root, { recursive: true, force: true })
  }
})

test('draft, no approval, changed SHA and empty components never start DSH', async () => {
  for (const scenario of [
    { status: 'draft' },
    { approval: false },
    { componentOverrides: { specificationCommit: SHA_C }, approvalOverrides: { repository: 'tenkrol/agent', changeId: 'PLA-99', baseCommit: SHA_A, specificationCommit: SHA_B, branch: 'spec/REQ-0009-PLA-99' } },
    { manifestOverrides: { components: [] } },
  ]) {
    const ctx = await setup(scenario)
    try {
      let runs = 0
      const impl = service(ctx.git, { async run() { runs += 1; return { ok: true, usage: {} } } })
      await assert.rejects(() => impl.implement({ requestId: 'REQ-0009', specRepo: 'x', specDir: ctx.specDir, keyPath: '/tmp/key' }), /не готова/)
      assert.equal(runs, 0)
    } finally {
      await fs.rm(ctx.root, { recursive: true, force: true })
    }
  }
})

test('a failed DSH run records failed and does not publish an impl branch', async () => {
  const ctx = await setup()
  try {
    const pushes = []
    const git = { ...ctx.git, async commitAndPush(options) { pushes.push(options); return { sha: SHA_C, compareUrl: 'x' } } }
    const impl = service(git, { async run() { return { ok: false, text: 'провал' } } })
    await assert.rejects(() => impl.implement({ requestId: 'REQ-0009', specRepo: 'x', specDir: ctx.specDir, keyPath: '/tmp/key' }), /DSH/)
    assert.ok(!pushes.some((push) => push.branch?.startsWith('impl/')), 'ветка impl не публикуется')
    const status = JSON.parse(await fs.readFile(path.join(ctx.dir, 'status.json'), 'utf8'))
    assert.equal(status.state, 'failed')
  } finally {
    await fs.rm(ctx.root, { recursive: true, force: true })
  }
})

test('red checks block publication and keep failed state', async () => {
  const ctx = await setup()
  try {
    const pushes = []
    const git = { ...ctx.git, async commitAndPush(options) { pushes.push(options); return { sha: SHA_C, compareUrl: 'x' } } }
    const impl = service(git, { async run() { return { ok: true, usage: {} } } }, {
      maxRepairs: 1,
      runChecks: async () => ({ checks: [{ command: 'node --test', exitCode: 1, stdout: 'fail', stderr: '' }] }),
    })
    await assert.rejects(() => impl.implement({ requestId: 'REQ-0009', specRepo: 'x', specDir: ctx.specDir, keyPath: '/tmp/key' }), /проверки/)
    assert.ok(!pushes.some((push) => push.branch?.startsWith('impl/')))
  } finally {
    await fs.rm(ctx.root, { recursive: true, force: true })
  }
})

test('cancellation before checks never publishes and records cancelled', async () => {
  const ctx = await setup()
  const controller = new AbortController()
  try {
    const pushes = []
    const git = { ...ctx.git, async commitAndPush(options) { pushes.push(options); return { sha: SHA_C, compareUrl: 'x' } } }
    const impl = service(git, {
      async run() {
        controller.abort()
        return { ok: true, usage: {} }
      },
    })
    await assert.rejects(
      () => impl.implement({ requestId: 'REQ-0009', specRepo: 'x', specDir: ctx.specDir, keyPath: '/tmp/key', signal: controller.signal }),
      (error) => error.name === 'AbortError',
    )
    assert.ok(!pushes.some((push) => push.branch?.startsWith('impl/')))
    const status = JSON.parse(await fs.readFile(path.join(ctx.dir, 'status.json'), 'utf8'))
    assert.equal(status.state, 'cancelled')
  } finally {
    await fs.rm(ctx.root, { recursive: true, force: true })
  }
})

test('verified request rejects a second attempt unless retry is explicit', async () => {
  const ctx = await setup({ status: 'verified' })
  try {
    let runs = 0
    const impl = service(ctx.git, { async run() { runs += 1; return { ok: true, usage: {} } } }, {
      runChecks: async () => ({ checks: [] }),
    })
    await assert.rejects(() => impl.implement({ requestId: 'REQ-0009', specRepo: 'x', specDir: ctx.specDir, keyPath: '/tmp/key' }), /уже реализована/)
    assert.equal(runs, 0)
    const result = await impl.implement({ requestId: 'REQ-0009', specRepo: 'x', specDir: ctx.specDir, keyPath: '/tmp/key', retry: true })
    assert.equal(result.state, 'verified')
    assert.equal(runs, 1)
  } finally {
    await fs.rm(ctx.root, { recursive: true, force: true })
  }
})
