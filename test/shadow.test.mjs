import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createShadowStore } from '../src/workflow/shadow.mjs'

test('shadow collects suggestions silently and tracks decisions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-'))
  try {
    const store = createShadowStore({ file: path.join(dir, 'shadow.json'), now: () => 1000 })
    const added = await store.collect([{ id: 's1', title: 'A' }, { id: 's1', title: 'A' }])
    assert.equal(added.length, 1)
    await store.decide('s1', 'accepted', { reason: 'полезно' })
    const stats = await store.stats()
    assert.deepEqual(stats, { total: 1, shadow: 0, accepted: 1, rejected: 0, later: 0, acted: 0 })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('shadow survives restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-'))
  try {
    const file = path.join(dir, 'shadow.json')
    await createShadowStore({ file, now: () => 1000 }).collect([{ id: 's2', title: 'B' }])
    const restarted = createShadowStore({ file, now: () => 2000 })
    assert.equal((await restarted.list()).length, 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
