/**
 * Клиент модели обязан различать реальный usage и его отсутствие.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createModelClient } from '../src/integrations/model.mjs'

const client = (payload) => createModelClient({
  baseUrl: 'http://model.test',
  apiKey: 'k',
  model: 'm',
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => payload }),
})

test('reported usage keeps numbers', async () => {
  const result = await client({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }).askModel('x')
  assert.equal(result.usage.totalTokens, 7)
  assert.equal(result.usage.inputTokens, 3)
  assert.equal(result.usage.outputTokens, 4)
  assert.notEqual(result.usage.unknown, true)
})

test('missing usage is unknown, not zero', async () => {
  const result = await client({ choices: [{ message: { content: 'ok' } }] }).askModel('x')
  assert.equal(result.usage.totalTokens, undefined)
  assert.equal(result.usage.unknown, true)
})
