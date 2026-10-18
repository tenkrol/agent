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
