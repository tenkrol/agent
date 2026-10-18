import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createActionPolicy } from '../src/workflow/action-policy.mjs'

test('observe never acts; prepare only prepares', () => {
  const policy = createActionPolicy({ mode: 'observe' })
  assert.equal(policy.decide({ action: 'deploy' }).allowed, false)
  policy.setMode('prepare')
  assert.equal(policy.decide({ action: 'deploy' }).allowed, false)
  assert.equal(policy.decide({ action: 'prepare:diff' }).allowed, true)
})

test('execute requires allowlist, budget and approval; cancel disables all', () => {
  const policy = createActionPolicy({ mode: 'execute', allowlist: ['prepare:diff'], budget: { limit: 10 }, approvalRequired: true })
  assert.equal(policy.decide({ action: 'deploy' }).allowed, false)
  assert.equal(policy.decide({ action: 'prepare:diff' }).requiresApproval, true)
  policy.setEnabled(true)
  const unapproved = createActionPolicy({ mode: 'execute', allowlist: ['act'], approvalRequired: false, budget: { limit: 5 } })
  assert.equal(unapproved.decide({ action: 'act', cost: 4 }).allowed, true)
  assert.equal(unapproved.decide({ action: 'act', cost: 2 }).allowed, false)
  policy.cancel()
  assert.equal(policy.decide({ action: 'prepare:diff' }).allowed, false)
})
