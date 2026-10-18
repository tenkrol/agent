import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canTransition, validateImplementable } from '../src/workflow/request-state.mjs'

const sha = (char) => char.repeat(40)
const manifest = {
  requestId: 'REQ-0001',
  revision: 1,
  components: [{ repository: 'tenkrol/agent', changeId: 'PLA-40', baseCommit: sha('a'), specificationCommit: sha('b') }],
}
const approval = {
  requestId: 'REQ-0001',
  revision: 1,
  approvedBy: 'owner',
  approvedAt: '2026-10-18T20:00:00.000Z',
  components: manifest.components,
}

test('draft and missing approval cannot start implementation', () => {
  assert.equal(validateImplementable({ manifest, status: { state: 'draft' } }).ok, false)
  assert.equal(validateImplementable({ manifest, approval, status: { state: 'draft' } }).ok, false)
  assert.equal(validateImplementable({ manifest }).ok, false)
})

test('approved/ready with matching approval can start', () => {
  assert.equal(validateImplementable({ manifest, approval, status: { state: 'ready' } }).ok, true)
  assert.equal(validateImplementable({ manifest, approval }).ok, true)
})

test('changed specification SHA invalidates approval', () => {
  const changed = { ...manifest, components: [{ ...manifest.components[0], specificationCommit: sha('c') }] }
  const result = validateImplementable({ manifest: changed, approval, status: { state: 'ready' } })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((line) => /SHA спецификации/.test(line)))
})

test('empty components are invalid, not a fake success', () => {
  assert.equal(validateImplementable({ manifest: { ...manifest, components: [] }, approval: { ...approval, components: [] }, status: { state: 'ready' } }).ok, false)
})

test('running/verified reject a second attempt without retry', () => {
  assert.equal(validateImplementable({ manifest, approval, status: { state: 'running' } }).ok, false)
  assert.equal(validateImplementable({ manifest, approval, status: { state: 'verified' } }).ok, false)
  assert.equal(validateImplementable({ manifest, approval, status: { state: 'verified' }, retry: true }).ok, true)
})

test('lifecycle transitions are explicit', () => {
  assert.equal(canTransition('draft', 'approved'), true)
  assert.equal(canTransition('draft', 'running'), false)
  assert.equal(canTransition('running', 'verified'), true)
  assert.equal(canTransition('verified', 'release_pending'), true)
  assert.equal(canTransition('release_pending', 'released'), true)
})
