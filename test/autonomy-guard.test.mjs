import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(root, 'src', 'autonomy')

test('автономия не импортирует ядро', async () => {
  const offenders = []
  for (const entry of await fs.readdir(DIR, { withFileTypes: true })) {
    if (!entry.name.endsWith('.mjs')) continue
    const text = await fs.readFile(path.join(DIR, entry.name), 'utf8')
    if (/from '\.\.\/(bot|index)\.mjs'/.test(text)) offenders.push(entry.name)
  }
  assert.deepEqual(offenders, [], `импорт ядра в autonomy: ${offenders.join(', ')}`)
})

test('публичный API домена на месте', async () => {
  const autonomy = await import('../src/autonomy/index.mjs')
  for (const name of ['baseline', 'readiness', 'renderReport', 'evaluateTriggers', 'renderDigest']) {
    assert.equal(typeof autonomy[name], 'function', name)
  }
})
