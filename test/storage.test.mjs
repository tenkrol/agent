import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { quarantineCorrupt, StateStore, writeAtomic } from '../src/storage/index.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'storage-test-'))

test('атомарная запись: файл валиден, временных файлов не остаётся', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'state.json')
    await writeAtomic(file, '{"ok":true}\n')
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { ok: true })
    const leftovers = (await fs.readdir(dir)).filter((name) => name.includes('.tmp'))
    assert.deepEqual(leftovers, [], 'временные файлы убраны')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('состояние: запись и чтение через хранилище', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'state.json')
    const store = await new StateStore({ file, saveDelayMs: 1 }).load()
    store.set('cursor:1', 42)
    await store.flush()
    const reloaded = await new StateStore({ file }).load()
    assert.equal(reloaded.get('cursor:1'), 42)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('битый файл откладывается в копию, а не теряется', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'state.json')
    await fs.writeFile(file, '{это не json', 'utf8')
    const store = await new StateStore({ file }).load()
    assert.equal(store.entries().length, 0, 'стартуем с пустым состоянием')
    const copies = (await fs.readdir(dir)).filter((name) => name.includes('.corrupt-'))
    assert.equal(copies.length, 1, 'копия повреждённого файла сохранена')
    assert.equal(await fs.readFile(path.join(dir, copies[0]), 'utf8'), '{это не json')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('файл незнакомой версии схемы не принимается как валидный', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'state.json')
    await fs.writeFile(file, JSON.stringify({ version: 99, data: { курсор: 1 } }), 'utf8')
    const store = await new StateStore({ file }).load()
    assert.equal(store.entries().length, 0)
    const copies = (await fs.readdir(dir)).filter((name) => name.includes('.corrupt-'))
    assert.equal(copies.length, 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('quarantineCorrupt копирует файл рядом с датой в имени', async () => {
  const dir = await tempDir()
  try {
    const file = path.join(dir, 'usage.json')
    await fs.writeFile(file, 'x', 'utf8')
    const copy = await quarantineCorrupt(file, { now: new Date('2026-10-17T12:00:00Z') })
    assert.match(path.basename(copy), /usage\.json\.corrupt-2026-10-17/)
    assert.equal(await fs.readFile(copy, 'utf8'), 'x')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('файлы состояния пишет только домен storage', async () => {
  const offenders = []
  const walk = async (at) => {
    for (const entry of await fs.readdir(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) {
        if (path.basename(full) === 'storage') continue
        await walk(full)
      } else if (entry.name.endsWith('.mjs')) {
        const text = await fs.readFile(full, 'utf8')
        if (/(writeFile|appendFile)\w*\([^)]*['"]state\//.test(text)) offenders.push(path.relative(root, full))
      }
    }
  }
  await walk(path.join(root, 'src'))
  assert.deepEqual(offenders, [], `запись состояния вне src/storage/: ${offenders.join(', ')}`)
})
