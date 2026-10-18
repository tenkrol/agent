import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeRequest } from '../src/workflow/analyze.mjs'

test('assistant-only and agent-only requests map to one component', () => {
  assert.deepEqual(analyzeRequest('Добавь кнопку в боте').components.map((item) => item.repository), ['tenkrol/assistant'])
  assert.deepEqual(analyzeRequest('Почини очередь задач агента').components.map((item) => item.repository), ['tenkrol/agent'])
})

test('a request touching both components has two components', () => {
  const result = analyzeRequest('Бот должен показывать релиз агента')
  assert.deepEqual(result.components.map((item) => item.repository).sort(), ['tenkrol/agent', 'tenkrol/assistant'])
  assert.equal(result.ambiguous, false)
})

test('an unclear request asks the owner', () => {
  const result = analyzeRequest('Сделай лучше')
  assert.equal(result.ambiguous, true)
  assert.match(result.question, /компонент/)
})
