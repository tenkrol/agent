import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { scanRequests } from '../tools/spec-sync.mjs'

const manifest = (id) => ({
  schemaVersion: 1,
  requestId: id,
  revision: 1,
  executionPolicy: 'reviewed',
  releasePolicy: 'manual',
  components: [{ repository: 'tenkrol/agent', changeId: 'PLA-27', baseCommit: 'a'.repeat(40), specificationCommit: 'b'.repeat(40) }],
})

test('scanRequests returns valid ready manifests and reports broken ones', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-sync-'))
  try {
    await fs.mkdir(path.join(dir, 'requests', 'REQ-0002'), { recursive: true })
    await fs.writeFile(path.join(dir, 'requests', 'REQ-0002', 'manifest.json'), JSON.stringify(manifest('REQ-0002')))
    await fs.mkdir(path.join(dir, 'requests', 'REQ-0003'), { recursive: true })
    await fs.writeFile(path.join(dir, 'requests', 'REQ-0003', 'manifest.json'), '{"schemaVersion":1}')
    const result = await scanRequests(dir)
    assert.equal(result.ok, false)
    assert.deepEqual(result.ready.map((item) => item.requestId), ['REQ-0002'])
    assert.equal(result.issues[0].requestId, 'REQ-0003')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
