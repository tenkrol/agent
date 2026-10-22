/**
 * Порт прогона проверок кода (PLA-15).
 *
 * Команды приходят уже разобранными на argv из allowlist конфига; оболочка не
 * используется никогда. Каталог обязан быть внутри рабочей папки задачи, процесс
 * ограничен таймаутом и убивается вместе с группой.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const cancelled = () => Object.assign(new Error('проверка отменена'), { name: 'AbortError', code: 'ABORT_ERR' })

async function insideRoot(root, cwd) {
  const base = await fs.realpath(String(root))
  const target = await fs.realpath(path.resolve(base, String(cwd ?? '.'))).catch(() => path.resolve(base, String(cwd ?? '.')))
  const relative = path.relative(base, target)
  return !(relative.startsWith('..') || path.isAbsolute(relative))
}

const runOne = (argv, { cwd, timeoutMs, signal }) => new Promise((resolve) => {
  const started = Date.now()
  let stdout = ''
  let stderr = ''
  let settled = false
  const finish = (exitCode, extra = {}) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    resolve({
      command: argv.join(' '),
      exitCode,
      stdout: stdout.slice(-4000),
      stderr: stderr.slice(-4000),
      durationMs: Date.now() - started,
      ...extra,
    })
  }
  let child
  try {
    child = spawn(argv[0], argv.slice(1), { cwd, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    finish(null, { error: String(error?.message ?? error) })
    return
  }
  const onAbort = () => { try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} } finish(null, { error: 'проверка отменена', aborted: true }) }
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* уже умер */ } }
    finish(124, { error: 'таймаут проверки' })
  }, timeoutMs)
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  child.once('error', (error) => finish(null, { error: String(error.message ?? error) }))
  child.once('exit', (code) => finish(code))
})

/**
 * Запустить разрешённые проверки.
 *
 * @param {object} input - `root`, `cwd`, `commands` (массив argv), `timeoutMs`.
 * @returns {Promise<{checks: object[]}>} результаты по каждой команде.
 */
export async function runCodeChecks({ root, cwd = root, commands = [], timeoutMs = 300_000, signal } = {}) {
  if (!Array.isArray(commands) || commands.length === 0) return { checks: [] }
  if (!(await insideRoot(root, cwd))) throw new Error('cwd вне рабочей папки задачи')
  if (signal?.aborted) throw cancelled()
  const checks = []
  for (const command of commands) {
    const argv = Array.isArray(command) ? command : []
    if (argv.length === 0 || argv.some((part) => typeof part !== 'string' || part.trim() === '')) {
      checks.push({ command: argv.join(' '), exitCode: null, stdout: '', stderr: '', error: 'пустая команда' })
      continue
    }
    if (signal?.aborted) throw cancelled()
    const check = await runOne(argv, { cwd, timeoutMs, signal })
    if (check.aborted || signal?.aborted) throw cancelled()
    checks.push(check)
  }
  return { checks }
}
