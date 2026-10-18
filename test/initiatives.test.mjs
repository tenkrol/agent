import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createInitiativeService, inQuietHours } from '../src/workflow/initiatives.mjs'

const at = (iso) => () => Date.parse(iso)

test('daily limit, dedupe and quiet hours are enforced', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'initiatives-'))
  try {
    const service = createInitiativeService({ file: path.join(dir, 'i.json'), dailyLimit: 2, timeZone: 'UTC', now: at('2026-10-18T12:00:00Z') })
    const first = await service.propose([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }])
    assert.equal(first.length, 2)
    assert.equal((await service.propose([{ id: 'a' }])).length, 0, 'дубликат в тот же день')
    const quiet = createInitiativeService({ file: path.join(dir, 'q.json'), quietHours: { from: 23, to: 8 }, timeZone: 'UTC', now: at('2026-10-18T23:30:00Z') })
    assert.deepEqual(await quiet.propose([{ id: 'night' }]), [])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('never suppresses the signature across days, later does not', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'initiatives-'))
  try {
    const file = path.join(dir, 'i.json')
    const service = createInitiativeService({ file, timeZone: 'UTC', now: at('2026-10-18T12:00:00Z') })
    await service.propose([{ id: 'x', title: 'X' }])
    await service.decide('x', 'never')
    const nextDay = createInitiativeService({ file, timeZone: 'UTC', now: at('2026-10-19T12:00:00Z') })
    assert.equal((await nextDay.propose([{ id: 'x' }])).length, 0)
    assert.equal((await nextDay.propose([{ id: 'y' }])).length, 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('quiet hours crossing midnight', () => {
  assert.equal(inQuietHours(new Date('2026-10-18T23:30:00Z'), { from: 23, to: 8 }), true)
  assert.equal(inQuietHours(new Date('2026-10-18T07:59:00Z'), { from: 23, to: 8 }), true)
  assert.equal(inQuietHours(new Date('2026-10-18T12:00:00Z'), { from: 23, to: 8 }), false)
})
