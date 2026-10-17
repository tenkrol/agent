/**
 * Порты проверки в домене tools: открытие документов/таблиц и рендер.
 *
 * Каждый путь разрешается относительно `root` рабочей папки задачи; выход за её
 * пределы (включая `..` и симлинки наружу) отклоняется. Процессы LibreOffice
 * живут здесь, в tools, а не в домене verification.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { extractText } from './extract.mjs'

/** Resolve a path inside the task root, rejecting escapes. */
export async function resolveInside(root, candidate) {
  const base = await fs.realpath(String(root))
  const target = path.resolve(base, String(candidate ?? ''))
  const relative = path.relative(base, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('путь вне рабочей папки задачи')
  }
  // Симлинк внутри может указывать наружу: проверяем реальный путь.
  let real = target
  try {
    real = await fs.realpath(target)
  } catch {
    real = await fs.realpath(path.dirname(target)).then((dir) => path.join(dir, path.basename(target))).catch(() => target)
  }
  const realRelative = path.relative(base, real)
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error('путь вне рабочей папки задачи (симлинк)')
  }
  return target
}

const readBytes = async (root, relPath) => {
  const file = await resolveInside(root, relPath)
  return { file, bytes: await fs.readFile(file) }
}

/** Открыть документ и вернуть текст. */
export async function inspectDocument({ root, path: relPath, name } = {}) {
  try {
    const { bytes } = await readBytes(root, relPath)
    const extracted = extractText({ fileName: name ?? relPath, bytes })
    return { opens: !extracted.error, text: extracted.text ?? '', error: extracted.error }
  } catch (error) {
    return { opens: false, text: '', error: String(error?.message ?? error) }
  }
}

const FORMULA_ERROR = /#(?:REF|VALUE|DIV\/0|NAME|N\/A|NUM|NULL)!?/g

/** Открыть таблицу, вернуть текст и найденные ошибки формул. */
export async function inspectSpreadsheet({ root, path: relPath, name } = {}) {
  const inspected = await inspectDocument({ root, path: relPath, name })
  return { ...inspected, errors: [...new Set(String(inspected.text ?? '').match(FORMULA_ERROR) ?? [])] }
}

/** Есть ли LibreOffice. */
async function sofficeAvailable() {
  return new Promise((resolve) => {
    const child = spawn('soffice', ['--version'], { stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('exit', (code) => resolve(code === 0))
  })
}

/** Конвертировать файл во временный каталог через LibreOffice. */
async function convert(root, relPath, target) {
  if (!(await sofficeAvailable())) return { ok: false, error: 'LibreOffice недоступен' }
  const source = await resolveInside(root, relPath)
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-'))
  const args = ['--headless', '--convert-to', target, '--outdir', outDir, source]
  const result = await new Promise((resolve) => {
    const child = spawn('soffice', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, error: 'таймаут LibreOffice' })
    }, 120_000)
    child.stderr.on('data', (chunk) => { stderr += chunk.toString().slice(0, 1000) })
    child.once('error', (error) => { clearTimeout(timer); resolve({ ok: false, error: String(error.message ?? error) }) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) resolve({ ok: false, error: stderr || `код ${code}` })
      else resolve({ ok: true, dir: outDir })
    })
  })
  if (!result.ok) { await fs.rm(outDir, { recursive: true, force: true }).catch(() => {}); return result }
  const files = await fs.readdir(outDir).catch(() => [])
  if (files.length === 0) return { ok: false, error: 'LibreOffice не создал файл' }
  return { ok: true, path: path.join(outDir, files[0]) }
}

/** Пересчитать таблицу (конвертация заставляет LibreOffice пересчитать формулы). */
export async function recalcSpreadsheet({ root, path: relPath, name } = {}) {
  const converted = await convert(root, relPath, 'xlsx')
  if (!converted.ok) return { ok: false, opens: false, text: '', errors: [], error: converted.error }
  try {
    const bytes = await fs.readFile(converted.path)
    const extracted = extractText({ fileName: 'recalc.xlsx', bytes })
    return {
      ok: true,
      opens: !extracted.error,
      text: extracted.text ?? '',
      errors: [...new Set(String(extracted.text ?? '').match(FORMULA_ERROR) ?? [])],
    }
  } finally {
    await fs.rm(path.dirname(converted.path), { recursive: true, force: true }).catch(() => {})
  }
}

/** Отрендерить документ (PDF) для проверки отображения. */
export async function renderDocument({ root, path: relPath } = {}) {
  const converted = await convert(root, relPath, 'pdf')
  return converted.ok ? { ok: true, path: converted.path } : { ok: false, error: converted.error }
}
