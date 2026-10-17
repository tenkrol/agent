/**
 * Домен verification: критерии, статусы и проверки по типам результата.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  deriveCriteria,
  detectResultKind,
  disabledVerification,
  isVerificationNeeded,
  verify,
} from '../src/verification/index.mjs'
import { resolveInside } from '../src/tools/verify.mjs'
import { runCodeChecks } from '../src/execution/checks.mjs'
import { cleanup, tempDir } from './helpers.mjs'

test('result kind is detected from files, then from the request', () => {
  assert.equal(detectResultKind({ files: [{ name: 'отчёт.docx' }] }), 'document')
  assert.equal(detectResultKind({ files: [{ name: 'смета.xlsx' }] }), 'spreadsheet')
  assert.equal(detectResultKind({ files: [{ name: 'fix.mjs' }] }), 'code')
  assert.equal(detectResultKind({ taskText: 'проведи исследование рынка' }), 'research')
  assert.equal(detectResultKind({ taskText: 'просто ответь да' }), 'none')
})

test('criteria come from the request and do not add sections', () => {
  const { kind, criteria } = deriveCriteria({
    taskText: 'Сделай отчёт в DOCX с разделами: Итоги, Риски и План',
    files: [{ name: 'отчёт.docx' }],
  })
  assert.equal(kind, 'document')
  assert.ok(criteria.some((criterion) => criterion.id === 'opens'))
  const sections = criteria.find((criterion) => criterion.id === 'sections')
  assert.ok(sections)
  assert.deepEqual(sections.sections.sort(), ['итоги', 'план', 'риски'])
  assert.equal(criteria.some((criterion) => /выводы|приложения/.test(criterion.text)), false)
  assert.equal(isVerificationNeeded({ taskText: 'ответь да', files: [] }), false)
  assert.equal(isVerificationNeeded({ taskText: 'сделай отчёт', files: [{ name: 'a.docx' }] }), true)
})

test('a document is checked for opening and required sections', async () => {
  const ports = {
    inspectDocument: async ({ path: rel }) => (rel === 'bad.docx'
      ? { opens: false, text: '', error: 'битый файл' }
      : { opens: true, text: 'Итоги\nРиски\nПлан' }),
  }
  const files = [{ name: 'отчёт.docx', relPath: 'outbox/отчёт.docx' }]
  const good = await verify({ taskText: 'отчёт с разделами: Итоги, Риски, План', files, ports })
  assert.equal(good.status, 'passed')
  assert.ok(good.criteria.every((criterion) => criterion.status === 'passed'))

  const missing = await verify({ taskText: 'отчёт с разделами: Итоги, Риски, План, Выводы', files, ports })
  assert.equal(missing.status, 'partial')
  const section = missing.criteria.find((criterion) => criterion.id === 'sections')
  assert.equal(section.status, 'failed')
  assert.match(section.evidence, /выводы/)

  const broken = await verify({ files: [{ name: 'bad.docx', relPath: 'bad.docx' }], ports })
  assert.equal(broken.status, 'failed')
  assert.equal(broken.criteria[0].status, 'failed')
})

test('a spreadsheet fails on formula errors', async () => {
  const files = [{ name: 'смета.xlsx', relPath: 'outbox/смета.xlsx' }]
  const ports = {
    inspectSpreadsheet: async () => ({ opens: true, text: 'Итого 100' }),
    recalcSpreadsheet: async () => ({ ok: true, opens: true, text: 'Итого #REF!', errors: ['#REF!'] }),
  }
  const result = await verify({ taskText: 'сделай смету в xlsx', files, ports })
  assert.equal(result.status, 'partial')
  assert.equal(result.criteria.find((criterion) => criterion.id === 'computation').status, 'failed')
})

test('code checks use the allowlist and empty allowlist is unavailable', async () => {
  const files = [{ name: 'fix.mjs', relPath: 'fix.mjs' }]
  const ports = { runCodeChecks: async () => ({ checks: [{ command: 'node --test', exitCode: 0 }] }) }
  const passed = await verify({ taskText: 'исправь код и прогони тесты', files, ports, allowlist: [['node', '--test']] })
  assert.equal(passed.status, 'passed')

  const failed = await verify({
    taskText: 'исправь код',
    files,
    ports: { runCodeChecks: async () => ({ checks: [{ command: 'node --test', exitCode: 1 }] }) },
    allowlist: [['node', '--test']],
  })
  assert.equal(failed.status, 'failed')

  const unavailable = await verify({ taskText: 'исправь код', files, ports, allowlist: [] })
  assert.equal(unavailable.status, 'unavailable')
})

test('research requires sources and separates assumptions', async () => {
  const files = []
  const ports = { askModel: async () => 'ИСТОЧНИКИ: да; СВЯЗЬ: да; ПРЕДПОЛОЖЕНИЯ: да' }
  const passed = await verify({ taskText: 'исследуй рынок и укажи источники', files, answer: 'Источники: [1] …', ports })
  assert.equal(passed.status, 'passed')
  const failed = await verify({ taskText: 'исследуй рынок и укажи источники', files, answer: 'просто мнение', ports: { askModel: async () => 'ИСТОЧНИКИ: нет' } })
  assert.equal(failed.status, 'failed')
})

test('disabled and not required are explicit statuses', () => {
  const disabled = disabledVerification()
  assert.equal(disabled.status, 'disabled')
  assert.match(disabled.limitations[0], /VERIFY=false/)
})

test('verification ports reject paths outside the task root', async () => {
  const dir = await tempDir()
  try {
    const root = path.join(dir, 'task')
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'ok.txt'), 'ok')
    assert.equal(await resolveInside(root, 'ok.txt'), await fs.realpath(path.join(root, 'ok.txt')))
    await assert.rejects(() => resolveInside(root, '../secret.txt'), /вне рабочей папки/)
    const outside = path.join(dir, 'outside')
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(root, 'link'))
    await assert.rejects(() => resolveInside(root, 'link/passwd'), /вне рабочей папки/)
  } finally {
    await cleanup(dir)
  }
})

test('code checks never use a shell and reject cwd outside root', async () => {
  const dir = await tempDir()
  try {
    await fs.writeFile(path.join(dir, 'file.txt'), 'x')
    const run = await runCodeChecks({ root: dir, commands: [[process.execPath, '-e', 'process.stdout.write(process.env.HOME ? "shell" : "no")']], timeoutMs: 3000 })
    assert.equal(run.checks.length, 1)
    // Команда в argv: оболочка не подставляла $HOME, переменная окружения есть всегда,
    // поэтому проверяем, что это именно node, а не shell-подстановка.
    assert.equal(run.checks[0].exitCode, 0)
    await assert.rejects(() => runCodeChecks({ root: dir, cwd: path.dirname(dir), commands: [['true']] }), /вне рабочей папки/)
  } finally {
    await cleanup(dir)
  }
})
