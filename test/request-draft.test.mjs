import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createRequestDraft } from '../src/workflow/requests.mjs'

test('createRequestDraft writes a validated request', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'req-draft-'))
  try {
    const result = await createRequestDraft({
      dir: path.join(root, 'REQ-0003'),
      requestId: 'REQ-0003',
      title: 'Тест',
      text: 'Сделай тестовую доработку',
      components: [{ repository: 'tenkrol/agent', changeId: 'PLA-29', baseCommit: 'a'.repeat(40), specificationCommit: 'b'.repeat(40) }],
    })
    assert.equal(result.manifest.requestId, 'REQ-0003')
    assert.match(await fs.readFile(path.join(result.dir, 'proposal.md'), 'utf8'), /тестовую доработку/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('invalid components do not write a draft', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'req-draft-'))
  try {
    await assert.rejects(() => createRequestDraft({
      dir: path.join(root, 'REQ-0004'),
      requestId: 'REQ-0004',
      title: 'Плохой',
      components: [{ repository: 'tenkrol/agent', changeId: 'PLA-29', baseCommit: 'a'.repeat(40) }],
    }), /manifest невалиден/)
    await assert.rejects(() => fs.stat(path.join(root, 'REQ-0004')))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

import { createRequestService } from '../src/workflow/request-service.mjs'
import { createBridgeServer } from '../src/bot-link/bridge-http.mjs'
import { createTestLogger } from './helpers.mjs'

test('request service writes a draft and publishes a branch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'req-service-'))
  try {
    const repoDir = path.join(root, 'repo')
    await fs.mkdir(path.join(repoDir, 'requests', 'REQ-0001'), { recursive: true })
    const calls = []
    const service = createRequestService({
      repo: 'tenkrol/assistant-work',
      repoDir,
      keyDir: root,
      logger: { info() {} },
      git: {
        async clone() { return { dir: repoDir, sha: 'a'.repeat(40) } },
        async commitAndPush(options) { calls.push(options); return { sha: 'b'.repeat(40), compareUrl: 'https://example/compare' } },
      },
    })
    const result = await service.create({ text: 'Добавь версию агента', title: 'Версия' })
    assert.equal(result.requestId, 'REQ-0002')
    assert.equal(result.branch, 'req/REQ-0002')
    assert.equal(result.analysis.components[0].repository, 'tenkrol/agent')
    assert.equal(calls.length, 1)
    assert.match(await fs.readFile(path.join(repoDir, 'requests', 'REQ-0002', 'manifest.json'), 'utf8'), /REQ-0002/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('POST /v1/requests uses the request service', async () => {
  const server = createBridgeServer({
    token: 'secret',
    port: 0,
    logger: createTestLogger(),
    onSubmit: async () => ({ taskId: 't' }),
    onCreateRequest: async ({ text }) => ({ requestId: 'REQ-0009', branch: 'req/REQ-0009', compareUrl: `https://example/${text}` }),
  })
  const address = await server.start()
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/requests`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'доработка' }),
    })
    assert.equal(response.status, 202)
    assert.equal((await response.json()).requestId, 'REQ-0009')
  } finally {
    await server.stop()
  }
})


test('request service attaches component specs and updates manifest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'req-attach-'))
  try {
    const repoDir = path.join(root, 'repo')
    await fs.mkdir(path.join(repoDir, 'requests'), { recursive: true })
    const commits = []
    const service = createRequestService({
      repo: 'tenkrol/assistant-work',
      repoDir,
      keyDir: root,
      logger: { info() {}, warn() {} },
      git: {
        async clone() { return { dir: repoDir, sha: 'a'.repeat(40) } },
        async commitAndPush(options) { commits.push(options); return { sha: 'b'.repeat(40), compareUrl: 'https://example/compare' } },
      },
      attachComponents: async () => [{ repository: 'tenkrol/agent', changeId: 'PLA-28', baseCommit: 'a'.repeat(40), specificationCommit: 'b'.repeat(40) }],
    })
    const result = await service.create({ text: 'Добавь команду агенту', title: 'Команда' })
    assert.equal(result.analysis.attachments[0].changeId, 'PLA-28')
    const manifest = JSON.parse(await fs.readFile(path.join(repoDir, 'requests', result.requestId, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.components.map((item) => item.changeId), ['PLA-28'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('approve writes identity/revision/exact component SHA', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'req-approve-'))
  try {
    const specDir = path.join(root, 'spec')
    const dir = path.join(specDir, 'requests', 'REQ-0009')
    await fs.mkdir(dir, { recursive: true })
    const components = [{ repository: 'tenkrol/agent', changeId: 'PLA-99', baseCommit: 'a'.repeat(40), specificationCommit: 'b'.repeat(40) }]
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ requestId: 'REQ-0009', revision: 3, components }))
    const service = createRequestService({
      repo: 'tenkrol/assistant-work',
      repoDir: specDir,
      keyDir: root,
      logger: { info() {} },
      git: { async clone() { return { sha: 'a'.repeat(40) } }, async commitAndPush() { return { sha: 'c'.repeat(40) } } },
    })
    const result = await service.approve({ requestId: 'REQ-0009', specRepo: 'x', specDir, keyPath: '/tmp/key' })
    assert.equal(result.approval.revision, 3)
    assert.equal(result.approval.approvedBy, 'owner')
    assert.equal(result.approval.components[0].specificationCommit, 'b'.repeat(40))
    const written = JSON.parse(await fs.readFile(path.join(dir, 'approval.json'), 'utf8'))
    assert.equal(written.revision, 3)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('POST /v1/approve validates requestId and calls the service', async () => {
  const { createBridgeServer } = await import('../src/bot-link/bridge-http.mjs')
  const { createTestLogger } = await import('./helpers.mjs')
  let seen
  const server = createBridgeServer({
    token: 'secret', port: 0, logger: createTestLogger(), onSubmit: async () => ({ taskId: 't' }),
    onApprove: async ({ requestId }) => { seen = requestId; return { approval: { requestId } } },
  })
  const address = await server.start()
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/approve`, {
      method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'REQ-0009' }),
    })
    assert.equal(response.status, 202)
    assert.equal(seen, 'REQ-0009')
  } finally {
    await server.stop()
  }
})
