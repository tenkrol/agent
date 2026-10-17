/**
 * Память версии 2: виды, происхождение, замена, срок, область и секреты (PLA-17).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { MemoryStore } from '../src/storage/memory.mjs'
import { createBotHarness, createTestLogger, tempDir, cleanup } from './helpers.mjs'

const makeStore = async (dir, options = {}) => new MemoryStore({
  file: path.join(dir, 'memory.json'),
  logger: createTestLogger(),
  ...options,
}).load()

test('version 1 is migrated with a backup and stays current', async () => {
  const dir = await tempDir()
  try {
    await fs.writeFile(path.join(dir, 'memory.json'), JSON.stringify({
      version: 1,
      facts: [{ id: 'f1', text: 'живёт в Москве', createdAt: 1, source: 'owner' }],
    }))
    const store = await makeStore(dir)
    assert.equal(store.size, 1)
    assert.equal(store.list()[0].text, 'живёт в Москве')
    assert.equal(store.list()[0].kind, 'preference')
    assert.ok(await fs.stat(path.join(dir, 'memory.json.v1.bak')))
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'memory.json'), 'utf8'))
    assert.equal(saved.version, 2)
  } finally {
    await cleanup(dir)
  }
})

test('a new value for the same subject replaces the old one and keeps history', async () => {
  const dir = await tempDir()
  try {
    const store = await makeStore(dir)
    await store.set({ subject: 'timezone', text: 'часовой пояс — Europe/Moscow' })
    await store.set({ subject: 'timezone', text: 'часовой пояс — Europe/Berlin' })
    const current = store.list().map((fact) => fact.text)
    assert.deepEqual(current, ['часовой пояс — Europe/Berlin'])
    const history = store.history('timezone')
    assert.equal(history.length, 1)
    assert.equal(history[0].status, 'superseded')
    assert.match(history[0].text, /Moscow/)
    const prompt = store.renderForTask({ text: 'составь отчёт', scope: { type: 'chat', value: 42 } })
    assert.match(prompt, /Berlin/)
    assert.equal(prompt.includes('Moscow'), false)
  } finally {
    await cleanup(dir)
  }
})

test('temporary facts expire and are not used, but remain in history', async () => {
  const dir = await tempDir()
  try {
    const store = await makeStore(dir)
    await store.add('сегодня работаем до 15:00', {
      kind: 'temporary',
      validUntil: Date.now() - 1000,
      source: 'owner',
    })
    assert.equal(store.size, 0)
    assert.equal(store.renderForTask({ text: 'отчёт' }), '')
    assert.equal(store.history().length, 1)
    assert.equal(store.history()[0].status, 'expired')
  } finally {
    await cleanup(dir)
  }
})

test('task facts are visible only in their own task', async () => {
  const dir = await tempDir()
  try {
    const store = await makeStore(dir)
    await store.add('в этой задаче источник — файл X', { kind: 'task', scope: { type: 'task', value: 't1' }, source: 'assistant' })
    const own = store.renderForTask({ text: 'источник', scope: { type: 'task', value: 't1' } })
    assert.match(own, /файл X/)
    const other = store.renderForTask({ text: 'источник', scope: { type: 'task', value: 't2' } })
    assert.equal(other.includes('файл X'), false)
  } finally {
    await cleanup(dir)
  }
})

test('secrets are rejected and never rendered', async () => {
  const dir = await tempDir()
  try {
    const store = await makeStore(dir)
    assert.equal(await store.add('ключ sk-abcdefghijklmnopqrstuvwxyz'), undefined)
    assert.equal(store.size, 0)
    await store.add('обычный факт про отчёты')
    const rendered = store.renderForTask({ text: 'отчёты' })
    assert.equal(/sk-/.test(rendered), false)
  } finally {
    await cleanup(dir)
  }
})

test('/memory set and /memory history keep the old value visible', async () => {
  const env = await createBotHarness()
  try {
    await env.memory.add('часовой пояс — Europe/Moscow', { source: 'owner', subject: 'timezone' })
    const set = await env.bot.memoryCommand('set timezone часовой пояс — Europe/Berlin')
    assert.match(set, /предмет timezone/)
    const current = env.memory.list().map((fact) => fact.text)
    assert.deepEqual(current, ['часовой пояс — Europe/Berlin'])
    const history = await env.bot.memoryCommand('history timezone')
    assert.match(history, /Moscow/)
    assert.match(history, /superseded/)
  } finally {
    await env.close()
  }
})
