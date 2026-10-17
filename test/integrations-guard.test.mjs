import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(root, 'src')

// Исключения сокращаются по мере переноса: bot.mjs (mirror — шаг bot-link) и
// bridge-http.mjs (входящий приём — шаг bot-link).
const ALLOWED = new Set([
  path.join(SRC, 'integrations', 'telegram.mjs'),
  path.join(SRC, 'integrations', 'yandex-disk.mjs'),
  path.join(SRC, 'bot.mjs'),
  path.join(SRC, 'bridge-http.mjs'),
])

test('сеть вызывается только в домене integrations (и в оставшихся местах bot-link)', async () => {
  const offenders = []
  const walk = async (at) => {
    for (const entry of await fs.readdir(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.mjs') && !ALLOWED.has(full)) {
        const text = await fs.readFile(full, 'utf8')
        if (/\bfetch\s*\(|node:https?['"]/.test(text)) offenders.push(path.relative(root, full))
      }
    }
  }
  await walk(SRC)
  assert.deepEqual(offenders, [], `сетевой вызов вне integrations: ${offenders.join(', ')}`)
})

test('публичный API домена на месте', async () => {
  const integrations = await import('../src/integrations/index.mjs')
  for (const name of ['TelegramClient', 'createTelegramPlatform', 'YandexDisk', 'joinPath']) {
    assert.equal(typeof integrations[name], 'function', name)
  }
  assert.equal(typeof (await import('../src/integrations/index.mjs')).formatDiskSize, 'function')
})
