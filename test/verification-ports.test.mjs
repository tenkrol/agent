/**
 * Реальная сборка портов проверки: options.signal доходит до modelClient.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createModelClient } from '../src/integrations/model.mjs'
import { createVerifyPorts } from '../src/verification/ports.mjs'
import { verify } from '../src/verification/index.mjs'

test('abort of a running verification request reaches the model fetch', async () => {
  let fetchSignal
  let started
  const ready = new Promise((resolve) => { started = resolve })
  const modelClient = createModelClient({
    baseUrl: 'http://model.test',
    apiKey: 'k',
    model: 'm',
    fetchImpl: async (url, options) => {
      fetchSignal = options.signal
      started()
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  })
  const ports = createVerifyPorts({ modelClient })
  const controller = new AbortController()
  const running = verify({
    taskText: 'исследуй рынок и укажи источники',
    answer: 'Источники: [1]',
    signal: controller.signal,
    ports,
  })
  await ready
  controller.abort()
  const result = await running
  assert.equal(fetchSignal.aborted, true)
  assert.notEqual(result.status, 'passed')
  assert.ok(result.limitations.some((line) => /отменена/.test(line)))
})
