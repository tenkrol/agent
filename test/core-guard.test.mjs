import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(root, 'src')
const DOMAINS = ['config', 'secrets', 'storage', 'integrations', 'execution', 'tools', 'delivery', 'bot-link', 'autonomy', 'ops']

test('домены не импортируют ядро', async () => {
  const offenders = []
  const walk = async (at) => {
    for (const entry of await fs.readdir(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.mjs')) {
        const text = await fs.readFile(full, 'utf8')
        if (/from '\.\.\/core\//.test(text)) offenders.push(path.relative(root, full))
      }
    }
  }
  for (const domain of DOMAINS) await walk(path.join(SRC, domain))
  assert.deepEqual(offenders, [], `домен импортирует core: ${offenders.join(', ')}`)
})

test('в корне src только index.mjs и общий format.mjs', async () => {
  const files = (await fs.readdir(SRC, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => entry.name)
    .sort()
  assert.deepEqual(files, ['format.mjs', 'index.mjs'])
})
