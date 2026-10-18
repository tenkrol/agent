import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDeployService } from '../src/workflow/deploy.mjs'

const base = {
  components: [{ repository: 'tenkrol/agent', dir: '/tmp/repo', keyPath: '/tmp/key' }],
  logger: { info() {} },
  git: {
    async clone() { return { sha: 'a'.repeat(40) } },
    async mergeAndPush() { return { sha: 'b'.repeat(40) } },
  },
}

test('deploy requires confirmation and green checks', async () => {
  let installed = 0
  const service = createDeployService({ ...base, checks: async () => ({ ok: false }), install: async () => { installed += 1 } })
  await assert.rejects(() => service.deploy({ requestId: 'REQ-0001', component: 'tenkrol/agent', branch: 'impl/x' }), /подтверждение/)
  await assert.rejects(() => service.deploy({ requestId: 'REQ-0001', confirm: 'REQ-0001', component: 'tenkrol/agent', branch: 'impl/x' }), /проверки/)
  assert.equal(installed, 0)
})

test('deploy merges and calls the installer after green checks', async () => {
  let installedSha
  const service = createDeployService({ ...base, checks: async () => ({ ok: true }), install: async ({ sha }) => { installedSha = sha; return { active: true } } })
  const result = await service.deploy({ requestId: 'REQ-0001', confirm: 'REQ-0001', component: 'tenkrol/agent', branch: 'impl/x' })
  assert.equal(result.sha, 'b'.repeat(40))
  assert.equal(installedSha, 'b'.repeat(40))
})

test('deploy without installer returns an explicit owner install step', async () => {
  const service = createDeployService({ ...base, checks: async () => ({ ok: true }) })
  const result = await service.deploy({ requestId: 'REQ-0001', confirm: 'REQ-0001', component: 'tenkrol/agent', branch: 'impl/x' })
  assert.equal(result.installed.required, true)
})

test('POST /v1/deploy requires token and forwards confirmation', async () => {
  const { createBridgeServer } = await import('../src/bot-link/bridge-http.mjs')
  const { createTestLogger } = await import('./helpers.mjs')
  const seen = []
  const server = createBridgeServer({
    token: 'secret',
    port: 0,
    logger: createTestLogger(),
    onSubmit: async () => ({ taskId: 't' }),
    onDeploy: async (body) => { seen.push(body.confirm); return { installed: { required: true } } },
  })
  const address = await server.start()
  try {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/v1/deploy`, { method: 'POST' })).status, 401)
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/deploy`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'REQ-0001', confirm: 'REQ-0001', component: 'tenkrol/agent', branch: 'impl/x' }),
    })
    assert.equal(response.status, 202)
    assert.deepEqual(seen, ['REQ-0001'])
  } finally {
    await server.stop()
  }
})
