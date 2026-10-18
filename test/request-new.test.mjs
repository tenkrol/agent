import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createRequest } from '../tools/request-new.mjs'

test('createRequest writes a valid request scaffold', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'req-'))
  try {
    const result = await createRequest({
      dir: path.join(dir, 'REQ-0001'),
      requestId: 'REQ-0001',
      title: 'Тестовая доработка',
      components: [{ repository: 'tenkrol/agent', changeId: 'PLA-28', baseCommit: 'a'.repeat(40), specificationCommit: 'b'.repeat(40) }],
    })
    assert.equal(result.manifest.requestId, 'REQ-0001')
    for (const name of ['request.md', 'proposal.md', 'acceptance.md', 'manifest.json']) {
      await fs.access(path.join(result.dir, name))
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
