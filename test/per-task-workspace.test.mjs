/**
 * PLA-20: изоляция рабочей папки задачи для параллельных workers.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { prepareTaskWorkspace, taskWorkspacePath } from '../src/execution/workspace.mjs'

test('per-task workspace is separate and has inbox/outbox/instructions', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'task-ws-'))
  try {
    await fs.writeFile(path.join(base, 'AGENTS.md'), 'instructions')
    const a = await prepareTaskWorkspace(base, 'task-a', { perTask: true })
    const b = await prepareTaskWorkspace(base, 'task-b', { perTask: true })
    assert.notEqual(a, b)
    assert.equal(a, taskWorkspacePath(base, 'task-a'))
    assert.equal(await fs.readFile(path.join(a, 'AGENTS.md'), 'utf8'), 'instructions')
    assert.equal(await fs.stat(path.join(a, 'inbox')).then((stat) => stat.isDirectory()), true)
    assert.equal(await fs.stat(path.join(a, 'outbox')).then((stat) => stat.isDirectory()), true)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('without perTask the shared workspace is returned unchanged', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'task-ws-'))
  try {
    assert.equal(await prepareTaskWorkspace(base, 'x', { perTask: false }), base)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})
