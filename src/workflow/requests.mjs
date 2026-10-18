/**
 * E4: draft заявки из текста владельца.
 *
 * Не анализирует код и не публикует: создаёт проверенный каркас, который агент
 * разработки дополнит спецификацией компонентов.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { validateManifest } from '../../tools/request-manifest.mjs'

export function requestTemplate({ requestId, title, text = '', components = [] } = {}) {
  const request = `# ${requestId}: ${title}\n\n${String(text ?? '').trim()}\n`
  return {
    'request.md': request,
    'proposal.md': `# Предложение\n\n## Поведение\n\n${String(text ?? '').trim()}\n\n## Границы\n\n`,
    'acceptance.md': '# Приёмка\n\n- [ ] наблюдаемый критерий\n',
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

export async function createRequestDraft({ dir, requestId, title, text = '', components = [] } = {}) {
  const files = requestTemplate({ requestId, title, text, components })
  const manifest = JSON.parse(files['manifest.json'])
  const checked = validateManifest(manifest)
  if (!checked.ok) throw new Error(`manifest невалиден: ${checked.errors.join('; ')}`)
  await fs.mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content, 'utf8')
  return { dir, manifest }
}
