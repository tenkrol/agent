import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** README — часть результата E5: контрольная строка не должна потеряться. */
test('README содержит строку E5 implementation check', async () => {
  const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8')
  assert.match(readme, /^E5 implementation check/m)
})
