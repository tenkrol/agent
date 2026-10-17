import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mirrorToAssistant } from '../src/bot-link/index.mjs'

const config = { outbox: { url: 'http://127.0.0.1:8788/outbox', token: 'secret-token' } }

test('зеркалирование: адрес, токен, обрезка и заголовок', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return { ok: true, status: 200 }
  }
  const result = await mirrorToAssistant('я'.repeat(4000), config, { fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:8788/outbox')
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret-token')
  const body = JSON.parse(calls[0].options.body)
  assert.equal(body.text.length, 3500, 'текст обрезан до 3 500 символов')
  assert.equal(body.title, 'Ответ агента')
})

test('нет токена — молча пропускаем', async () => {
  let called = false
  const result = await mirrorToAssistant('текст', { outbox: { url: '', token: '' } }, {
    fetchImpl: async () => { called = true; return { ok: true } },
  })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, 'нет токена')
  assert.equal(called, false)
})

test('ошибка отправки не бросает', async () => {
  const result = await mirrorToAssistant('текст', config, {
    fetchImpl: async () => { throw new Error('сеть недоступна') },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /сеть недоступна/)
})
