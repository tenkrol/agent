#!/usr/bin/env node
/**
 * Синхронизация репозитория заявок с очередью (E3).
 *
 * Читает requests/REQ-XXXX/manifest.json, проверяет схему и возвращает готовые
 * заявки. Не создаёт задач и не пишет в GitHub: это вход для планировщика E5.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { validateManifest } from './request-manifest.mjs'

export async function scanRequests(root) {
  const requestsDir = path.join(root, 'requests')
  let entries
  try {
    entries = await fs.readdir(requestsDir, { withFileTypes: true })
  } catch {
    return { ok: true, ready: [], issues: [] }
  }
  const ready = []
  const issues = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^REQ-\d{4,}$/.test(entry.name)) continue
    const file = path.join(requestsDir, entry.name, 'manifest.json')
    try {
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'))
      const checked = validateManifest(manifest)
      if (!checked.ok) issues.push({ requestId: entry.name, errors: checked.errors })
      else ready.push(manifest)
    } catch (error) {
      issues.push({ requestId: entry.name, errors: [error?.code === 'ENOENT' ? 'нет manifest.json' : String(error?.message ?? error)] })
    }
  }
  ready.sort((left, right) => String(left.requestId).localeCompare(String(right.requestId)))
  return { ok: issues.length === 0, ready, issues }
}

async function main() {
  const root = process.argv[2]
  if (!root) {
    console.error('usage: node tools/spec-sync.mjs <repo-dir>')
    process.exit(2)
  }
  const result = await scanRequests(root)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exit(result.ok ? 0 : 1)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  console.error(`ошибка: ${error?.message ?? error}`)
  process.exit(2)
})
