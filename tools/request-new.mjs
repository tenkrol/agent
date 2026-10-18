#!/usr/bin/env node
/**
 * Создать каркас заявки E3: request/proposal/acceptance/manifest.json.
 * Использование: node tools/request-new.mjs REQ-0001 "Название" [--dir DIR]
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { validateManifest } from './request-manifest.mjs'

export function requestTemplate({ requestId, title, components = [] } = {}) {
  return {
    'request.md': `# ${requestId}: ${title}\n\nИсходная потребность владельца без секретов.\n`,
    'proposal.md': `# Предложение\n\n## Границы\n\n## Совместимость\n`,
    'acceptance.md': `# Приёмка\n\n- [ ] наблюдаемый критерий\n`,
    'manifest.json': `${JSON.stringify({
      schemaVersion: 1,
      requestId,
      revision: 1,
      title,
      components,
      dependencies: [],
      executionPolicy: 'reviewed',
      releasePolicy: 'manual',
    }, null, 2)}\n`,
  }
}

export async function createRequest({ dir, requestId, title, components = [] } = {}) {
  const manifest = JSON.parse(requestTemplate({ requestId, title, components })['manifest.json'])
  const checked = validateManifest(manifest)
  if (!checked.ok) throw new Error(`манифест невалиден: ${checked.errors.join('; ')}`)
  await fs.mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(requestTemplate({ requestId, title, components }))) {
    await fs.writeFile(path.join(dir, name), content, 'utf8')
  }
  return { dir, manifest }
}

async function main() {
  const [requestId, title, ...rest] = process.argv.slice(2)
  const dirIndex = rest.indexOf('--dir')
  const dir = dirIndex >= 0 ? rest[dirIndex + 1] : path.join('requests', requestId ?? '')
  if (!requestId || !title || !dir) {
    console.error('usage: node tools/request-new.mjs REQ-0001 "Название" [--dir DIR]')
    process.exit(2)
  }
  const result = await createRequest({ dir, requestId, title })
  process.stdout.write(`${JSON.stringify({ ok: true, dir: result.dir })}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => {
  console.error(`ошибка: ${error?.message ?? error}`)
  process.exit(1)
})
