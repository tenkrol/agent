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
