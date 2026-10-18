import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateManifest } from '../tools/request-manifest.mjs'

const base = {
  schemaVersion: 1,
  requestId: 'REQ-0042',
  revision: 1,
  executionPolicy: 'reviewed',
  releasePolicy: 'manual',
  components: [{
    repository: 'tenkrol/agent',
    changeId: 'PLA-27',
    baseCommit: 'a'.repeat(40),
    specificationCommit: 'b'.repeat(40),
  }],
}

test('a valid manifest passes', () => {
  assert.deepEqual(validateManifest(base), { ok: true, errors: [] })
})

test('missing specification SHA and bad change id are rejected', () => {
  const manifest = structuredClone(base)
  manifest.components[0].changeId = 'bad'
  delete manifest.components[0].specificationCommit
  const result = validateManifest(manifest)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((line) => /changeId/.test(line)))
  assert.ok(result.errors.some((line) => /specificationCommit/.test(line)))
})

test('duplicate components and secrets are rejected', () => {
  const manifest = structuredClone(base)
  manifest.components.push({ ...manifest.components[0] })
  manifest.apiKey = 'secret-value'
  const result = validateManifest(manifest)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((line) => /дубликат/.test(line)))
  assert.ok(result.errors.some((line) => /секрет/.test(line)))
})
