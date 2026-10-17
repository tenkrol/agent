import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(root, 'src')

/** Все .mjs в src, кроме доменов config и secrets (у них свои правила и тесты). */
async function sources(at = SRC) {
  const found = []
  for (const entry of await fs.readdir(at, { withFileTypes: true })) {
    const full = path.join(at, entry.name)
    if (entry.isDirectory()) {
      if (full === path.join(SRC, 'config') || full === path.join(SRC, 'secrets')) continue
      found.push(...await sources(full))
    } else if (entry.name.endsWith('.mjs')) {
      found.push(full)
    }
  }
  return found
}

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

test('настройки читаются только в домене config', async () => {
  const offenders = []
  for (const file of await sources()) {
    const text = await fs.readFile(file, 'utf8')
    // Запрещено читать конкретные ключи (process.env.KEY). Передача окружения целиком
    // дочернему процессу (env = process.env в запуске DSH) — это не чтение настроек.
    if (/process\.env\s*[.\[]\s*['"A-Za-z_$]/.test(text)) offenders.push(path.relative(root, file))
  }
  assert.deepEqual(offenders, [], `process.env вне src/config/: ${offenders.join(', ')}`)
})

test('публичный API домена на месте', async () => {
  const config = await import('../src/config/index.mjs')
  assert.equal(typeof config.loadConfig, 'function')
  assert.equal(typeof config.secretsOf, 'function')
  assert.equal(typeof config.parseUserIds, 'function')
  assert.equal(typeof config.ConfigError, 'function')
})

test('файл секретов трогает только домен secrets', async () => {
  const offenders = []
  for (const file of await allSources()) {
    const relative = path.relative(root, file)
    if (relative.startsWith(path.join('src', 'secrets'))) continue
    const text = await fs.readFile(file, 'utf8')
    if (/agent\.env\.enc|prod\.env\.enc/.test(text)) offenders.push(relative)
  }
  assert.deepEqual(offenders, [], `шифртекст читается вне src/secrets/: ${offenders.join(', ')}`)
})
