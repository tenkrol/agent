import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createReviewService } from '../src/workflow/review.mjs'

test('review returns at most three fully explained suggestions', async () => {
  const service = createReviewService({
    now: () => 1000,
    observe: async () => ({
      sources: [{ id: 'github', status: 'unavailable', checkedAt: 900, error: 'access denied' }],
      findings: [{ source: 'github', at: 950, evidence: { sha: 'a'.repeat(40) } }],
    }),
  })
  const result = await service.review({ limit: 3 })
  assert.ok(result.suggestions.length >= 1 && result.suggestions.length <= 3)
  for (const suggestion of result.suggestions) {
    assert.ok(suggestion.sources.length > 0)
    assert.ok(suggestion.whyNow && suggestion.benefit && suggestion.cost && suggestion.verify)
  }
})

test('review does not invent suggestions without evidence', async () => {
  const service = createReviewService({ observe: async () => ({ sources: [], findings: [] }) })
  const result = await service.review()
  assert.deepEqual(result.suggestions, [])
})

test('review API returns suggestions', async () => {
  const { createBridgeServer } = await import('../src/bot-link/bridge-http.mjs')
  const { createTestLogger } = await import('./helpers.mjs')
  const server = createBridgeServer({ token: 'secret', port: 0, logger: createTestLogger(), onSubmit: async () => ({ taskId: 't' }), onReview: async () => ({ suggestions: [] }) })
  const address = await server.start()
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/review`, { method: 'POST', headers: { authorization: 'Bearer secret' } })
    assert.equal(response.status, 200)
  } finally {
    await server.stop()
  }
})
