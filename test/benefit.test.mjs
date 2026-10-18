import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateBenefit } from '../src/workflow/benefit.mjs'

test('improved, regressed and unchanged use actual values', () => {
  assert.equal(evaluateBenefit({ metric: 'success', before: { value: 1 }, after: { value: 2 } }).verdict, 'improved')
  assert.equal(evaluateBenefit({ metric: 'latency', before: { value: 100 }, after: { value: 80 }, higherIsBetter: false }).verdict, 'improved')
  assert.equal(evaluateBenefit({ metric: 'score', before: { value: 2 }, after: { value: 1 } }).verdict, 'regressed')
  assert.equal(evaluateBenefit({ metric: 'score', before: { value: 2 }, after: { value: 2 } }).verdict, 'unchanged')
})

test('missing data is no_data, not improvement', () => {
  const result = evaluateBenefit({ metric: 'score', before: undefined, after: { value: 1 } })
  assert.equal(result.verdict, 'no_data')
  assert.equal(result.memory, undefined)
})
