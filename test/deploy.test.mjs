import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDeployService } from '../src/workflow/deploy.mjs'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)

const manifest = {
  requestId: 'REQ-0009', revision: 2,
  components: [{ repository: 'tenkrol/agent', changeId: 'PLA-99', baseCommit: A, specificationCommit: B, branch: 'spec/REQ-0009-PLA-99' }],
}
const approval = {
  requestId: 'REQ-0009', revision: 2, approvedBy: 'owner', approvedAt: '2026-10-18T20:00:00.000Z',
  components: [{ repository: 'tenkrol/agent', changeId: 'PLA-99', baseCommit: A, specificationCommit: B }],
}
const verified = {
  requestId: 'REQ-0009', revision: 2, state: 'verified',
  results: [{ repository: 'tenkrol/agent', changeId: 'PLA-99', branch: 'impl/REQ-0009-PLA-99', specificationCommit: B, implementationCommit: C }],
}

function service(overrides = {}) {
  const calls = []
  const git = {
    async clone(options) { calls.push({ kind: 'clone', ...options }); return { sha: A } },
    async checkoutCommit(options) { calls.push({ kind: 'checkout', ...options }); return options.sha },
    async head() { return C },
    async mergeSha(options) { calls.push({ kind: 'merge', ...options }); return D },
    async push(options) { calls.push({ kind: 'push', ...options }); return D },
  }
  const instance = createDeployService({
    components: [{ repository: 'tenkrol/agent', keyPath: '/tmp/key', checks: [['node', '--test']] }],
    git,
    loadRequest: async () => ({ manifest, approval, status: verified }),
    baseDir: '/tmp/deploy',
    logger: { info() {} },
    checks: async () => ({ checks: [{ command: 'node --test', exitCode: 0 }] }),
    ...overrides,
  })
  return { instance, calls, git }
}

test('verified request merges, rechecks the integration result and publishes that SHA', async () => {
  const { instance, calls } = service()
  const result = await instance.deploy({ requestId: 'REQ-0009', component: 'tenkrol/agent', branch: 'impl/REQ-0009-PLA-99', confirm: 'REQ-0009' })
  assert.equal(result.implementationCommit, C)
  assert.equal(result.mergedSha, D)
  assert.equal(result.publishedSha, D)
  assert.equal(result.installed.state, 'installation_required')
  assert.ok(calls.some((call) => call.kind === 'checkout' && call.sha === C), 'checkout проверенного commit')
  assert.ok(calls.some((call) => call.kind === 'merge' && call.sha === C), 'merge проверенного commit')
  assert.ok(calls.some((call) => call.kind === 'push'), 'push после проверок')
})

test('draft/unapproved/foreign branch/no verified status are rejected', async () => {
  for (const overrides of [
    { loadRequest: async () => ({ manifest, approval: undefined, status: verified }) },
    { loadRequest: async () => ({ manifest, approval, status: { ...verified, state: 'draft' } }) },
    { loadRequest: async () => ({ manifest, approval, status: { ...verified, results: [] } }) },
  ]) {
    const { instance } = service(overrides)
    await assert.rejects(() => instance.deploy({ requestId: 'REQ-0009', component: 'tenkrol/agent', branch: 'impl/REQ-0009-PLA-99', confirm: 'REQ-0009' }), /не готова|verified|нет/)
  }
  const { instance } = service()
  await assert.rejects(() => instance.deploy({ requestId: 'REQ-0009', component: 'tenkrol/agent', branch: 'impl/other', confirm: 'REQ-0009' }), /ветка не принадлежит/)
})

test('failed integration checks never publish main', async () => {
  const pushes = []
  const { instance, git } = service({ checks: async () => ({ checks: [{ command: 'node --test', exitCode: 1 }] }) })
  git.push = async (options) => { pushes.push(options); return D }
  await assert.rejects(() => instance.deploy({ requestId: 'REQ-0009', component: 'tenkrol/agent', branch: 'impl/REQ-0009-PLA-99', confirm: 'REQ-0009' }), /проверки/)
  assert.equal(pushes.length, 0)
})

test('install result is reported separately from merge', async () => {
  const { instance } = service({ install: async () => ({ healthy: true, installedSha: D }) })
  const result = await instance.deploy({ requestId: 'REQ-0009', component: 'tenkrol/agent', branch: 'impl/REQ-0009-PLA-99', confirm: 'REQ-0009' })
  assert.equal(result.installed.state, 'healthy')
  assert.equal(result.states.healthy, true)
})
