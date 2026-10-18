#!/usr/bin/env node
/**
 * Валидатор манифеста заявки (E3).
 *
 * Использование: node tools/request-manifest.mjs <manifest.json | каталог REQ>
 * Проверяет схему и отсутствие секретов, печатает JSON-результат.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const SHA = /^[0-9a-f]{40}$/i
const REQUEST = /^REQ-\d{4,}$/
const CHANGE = /^(PLA|PLB)-\d+$/
const REPO = /^tenkrol\/[a-z0-9._-]+$/
const POLICIES = new Set(['reviewed', 'policy'])
const RELEASE = new Set(['manual', 'automatic-after-checks'])
const SECRET_KEY = /(token|password|secret|api[-_]?key|private[-_]?key)/i

export function validateManifest(manifest) {
  const errors = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, errors: ['манифест должен быть объектом'] }
  if (Number(manifest.schemaVersion) !== 1) errors.push('schemaVersion должен быть 1')
  if (!REQUEST.test(String(manifest.requestId ?? ''))) errors.push('requestId должен быть REQ-XXXX')
  if (!Number.isInteger(manifest.revision) || manifest.revision < 1) errors.push('revision должен быть >= 1')
  if (!POLICIES.has(manifest.executionPolicy)) errors.push('executionPolicy: reviewed|policy')
  if (!RELEASE.has(manifest.releasePolicy)) errors.push('releasePolicy: manual|automatic-after-checks')
  if (!Array.isArray(manifest.components)) errors.push('components обязателен')
  else if (manifest.components.length === 0 && manifest.draft !== true) errors.push('components обязателен (или draft:true)')
  const seen = new Set()
  for (const [index, component] of (manifest.components ?? []).entries()) {
    const prefix = `components[${index}]`
    if (!REPO.test(String(component?.repository ?? ''))) errors.push(`${prefix}.repository: tenkrol/<repo>`)
    if (!CHANGE.test(String(component?.changeId ?? ''))) errors.push(`${prefix}.changeId: PLA-*/PLB-*`)
    if (!SHA.test(String(component?.baseCommit ?? ''))) errors.push(`${prefix}.baseCommit: 40-hex SHA`)
    if (!SHA.test(String(component?.specificationCommit ?? ''))) errors.push(`${prefix}.specificationCommit: 40-hex SHA`)
    const key = `${component?.repository}:${component?.changeId}`
    if (seen.has(key)) errors.push(`${prefix}: дубликат ${key}`)
    seen.add(key)
  }
  const scan = (value, trail = '') => {
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (SECRET_KEY.test(key) && typeof child === 'string' && child.trim() !== '') errors.push(`секрет в поле ${trail}${key}`)
        scan(child, `${trail}${key}.`)
      }
    }
  }
  scan(manifest)
  return { ok: errors.length === 0, errors }
}

async function main() {
  const input = process.argv[2]
  if (!input) {
    console.error('usage: node tools/request-manifest.mjs <manifest.json|REQ-dir>')
    process.exit(2)
  }
  let file = input
  try {
    const stat = await fs.stat(input)
    if (stat.isDirectory()) file = path.join(input, 'manifest.json')
  } catch {
    // Пусть чтение ниже сообщит понятную ошибку.
  }
  const result = validateManifest(JSON.parse(await fs.readFile(file, 'utf8')))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exit(result.ok ? 0 : 1)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  console.error(`ошибка: ${error?.message ?? error}`)
  process.exit(2)
})
