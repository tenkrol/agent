import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOMAINS = ['config', 'secrets', 'storage', 'integrations', 'execution', 'tools', 'delivery', 'bot-link', 'autonomy', 'core', 'ops']

/** Индекс домена должен загружаться и что-то экспортировать. */
test('индексы доменов загружаются и экспортируют API', async () => {
  for (const domain of DOMAINS) {
    const indexFile = path.join(root, 'src', domain, 'index.mjs')
    await assert.doesNotReject(fs.access(indexFile), `${domain}: нет index.mjs`)
    const module = await import(`../src/${domain}/index.mjs`)
    assert.ok(Object.keys(module).length > 0, `${domain}: index.mjs ничего не экспортирует`)
  }
})

test('модули домена не лежат в корне src (кроме ядра и index)', async () => {
  const allowed = new Set([
    'index.mjs',
    // Общий модуль форматирования: используется и core, и bot-link, и delivery.
    'format.mjs',
  ])
  const extra = []
  for (const entry of await fs.readdir(path.join(root, 'src'), { withFileTypes: true })) {
    if (entry.isDirectory() || !entry.name.endsWith('.mjs')) continue
    if (!allowed.has(entry.name)) extra.push(entry.name)
  }
  assert.deepEqual(extra, [], `неожиданные модули в корне src: ${extra.join(', ')}`)
})
