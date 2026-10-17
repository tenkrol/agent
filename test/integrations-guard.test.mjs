import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(root, 'src')
const INTEGRATIONS = path.join(SRC, 'integrations')
const BOT_LINK = path.join(SRC, 'bot-link')

/** Все .mjs в src. */
async function allSources(at = SRC) {
  const found = []
  for (const entry of await fs.readdir(at, { withFileTypes: true })) {
    const full = path.join(at, entry.name)
    if (entry.isDirectory()) found.push(...await allSources(full))
    else if (entry.name.endsWith('.mjs')) found.push(full)
  }
  return found
}

test('клиентские сетевые вызовы — только в integrations', async () => {
  const offenders = []
  for (const file of await allSources()) {
    if (file.startsWith(INTEGRATIONS)) continue
    const text = await fs.readFile(file, 'utf8')
    if (/\bfetch\s*\(|node:https['"]/.test(text)) offenders.push(path.relative(root, file))
  }
  assert.deepEqual(offenders, [], `fetch/https вне integrations: ${offenders.join(', ')}`)
})

test('входящий HTTP-сервер — только integrations и bot-link', async () => {
  const offenders = []
  for (const file of await allSources()) {
    if (file.startsWith(INTEGRATIONS) || file.startsWith(BOT_LINK)) continue
    const text = await fs.readFile(file, 'utf8')
    if (/node:http['"]/.test(text)) offenders.push(path.relative(root, file))
  }
  assert.deepEqual(offenders, [], `node:http вне integrations/bot-link: ${offenders.join(', ')}`)
})

test('публичный API домена на месте', async () => {
  const integrations = await import('../src/integrations/index.mjs')
  for (const name of ['TelegramClient', 'createTelegramPlatform', 'YandexDisk', 'joinPath', 'sendTelegram', 'postOutbox']) {
    assert.equal(typeof integrations[name], 'function', name)
  }
})
