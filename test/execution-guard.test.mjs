import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(root, 'src')

// Исключение сокращается на шаге extract-tools: распознавание запускает локальный OCR.
const ALLOWED = new Set([path.join(SRC, 'ocr.mjs')])

test('процессы запускаются только в домене execution', async () => {
  const offenders = []
  const walk = async (at) => {
    for (const entry of await fs.readdir(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.mjs') && !ALLOWED.has(full)
        && !full.startsWith(path.join(SRC, 'execution'))) {
        const text = await fs.readFile(full, 'utf8')
        if (/node:child_process/.test(text)) offenders.push(path.relative(root, full))
      }
    }
  }
  await walk(SRC)
  assert.deepEqual(offenders, [], `child_process вне execution: ${offenders.join(', ')}`)
})
