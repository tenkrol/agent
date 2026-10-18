/**
 * Git/GitHub транспорт (E3). Только git CLI, без токенов в промптах.
 *
 * Deploy key передаётся через GIT_SSH_COMMAND; ключ не печатается в лог.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const GIT_TIMEOUT_MS = 120_000

function runGit(args, { cwd, keyPath, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    if (keyPath) env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes`
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`git timeout: ${args.join(' ')}`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString().slice(-2000) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
      else reject(new Error(`git ${args[0]} failed (${code}): ${stderr.trim().slice(-500)}`))
    })
  })
}

export function createGitHubClient({ keyDir = '/etc/agent/github', timeoutMs = GIT_TIMEOUT_MS, logger } = {}) {
  const keyFor = (repo) => path.join(keyDir, `${String(repo).split('/').pop()}_ed25519`)

  return {
    /** Клонировать или обновить рабочую копию; возвращает sha. */
    async clone({ repo, dir, branch = 'main', keyPath, depth = 0, fresh = false } = {}) {
      const key = keyPath ?? keyFor(repo)
      if (fresh) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      await fs.mkdir(path.dirname(dir), { recursive: true }).catch(() => {})
      try {
        await fs.access(path.join(dir, '.git'))
        await runGit(['fetch', 'origin'], { cwd: dir, keyPath: key, timeoutMs })
        await runGit(['checkout', branch], { cwd: dir, keyPath: key, timeoutMs })
        await runGit(['pull', '--ff-only', 'origin', branch], { cwd: dir, keyPath: key, timeoutMs })
      } catch {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
        await runGit(['clone', ...(depth > 0 ? ['--depth', String(depth)] : []), '--branch', branch, `git@github.com:${repo}.git`, dir], { keyPath: key, timeoutMs })
      }
      const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: dir, timeoutMs })
      logger?.info?.('github clone ready', { repo, branch, sha: stdout })
      return { dir, sha: stdout }
    },

    /** Создать ветку, закоммитить файлы и запушить; возвращает compare URL. */
    async commitAndPush({ repo, dir, branch, files = {}, message, keyPath } = {}) {
      const key = keyPath ?? keyFor(repo)
      if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error('недопустимое имя ветки')
      await runGit(['checkout', '-B', branch], { cwd: dir, keyPath: key, timeoutMs })
      for (const [relative, content] of Object.entries(files)) {
        const target = path.join(dir, relative)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, content, 'utf8')
      }
      if (Object.keys(files).length > 0) await runGit(['add', '--', ...Object.keys(files)], { cwd: dir, keyPath: key, timeoutMs })
      else await runGit(['add', '-A'], { cwd: dir, keyPath: key, timeoutMs })
      try {
        await runGit(['-c', 'user.name=tenkrol-agent', '-c', 'user.email=agent@tenkrol.local', 'commit', '-m', String(message)], { cwd: dir, keyPath: key, timeoutMs })
      } catch (error) {
        // DSH мог уже закоммитить изменения сам: пустой коммит — не ошибка.
        const status = await runGit(['status', '--porcelain'], { cwd: dir, timeoutMs })
        if (status.stdout !== '') throw error
      }
      await runGit(['push', '-u', 'origin', branch], { cwd: dir, keyPath: key, timeoutMs })
      const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: dir, timeoutMs })
      return { sha: stdout, compareUrl: `https://github.com/${repo}/compare/main...${branch}` }
    },

    /** Текущий HEAD рабочей копии. */
    async head({ dir } = {}) {
      const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: dir, timeoutMs })
      return stdout
    },

    /** Перейти на конкретный commit (ревизия спецификации, не верхушка ветки). */
    async checkoutCommit({ repo, dir, sha, keyPath } = {}) {
      const key = keyPath ?? keyFor(repo)
      if (!/^[0-9a-f]{40}$/i.test(String(sha))) throw new Error('нужен полный commit SHA')
      await runGit(['fetch', 'origin', sha], { cwd: dir, keyPath: key, timeoutMs })
      await runGit(['checkout', '--detach', sha], { cwd: dir, keyPath: key, timeoutMs })
      const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: dir, timeoutMs })
      if (stdout !== sha) throw new Error(`checkout не совпал с согласованным SHA: ${stdout} != ${sha}`)
      return stdout
    },

    /** Влить конкретный commit в текущую ветку без push (для проверки результата). */
    async mergeSha({ repo, dir, sha, message, keyPath } = {}) {
      const key = keyPath ?? keyFor(repo)
      if (!/^[0-9a-f]{40}$/i.test(String(sha))) throw new Error('нужен полный commit SHA')
      await runGit(['fetch', 'origin', sha], { cwd: dir, keyPath: key, timeoutMs })
      await runGit(['-c', 'user.name=tenkrol-agent', '-c', 'user.email=agent@tenkrol.local', 'merge', '--no-ff', sha, '-m', String(message ?? `integration ${sha}`)], { cwd: dir, keyPath: key, timeoutMs })
      const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: dir, timeoutMs })
      return stdout
    },

    /** Запушить текущую ветку (после проверок). */
    async push({ repo, dir, target = 'main', keyPath } = {}) {
      const key = keyPath ?? keyFor(repo)
      await runGit(['push', 'origin', `${target}`], { cwd: dir, keyPath: key, timeoutMs })
      const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: dir, timeoutMs })
      return stdout
    },

    /** Слить ветку в target (обычно main) и запушить. */
    async mergeAndPush({ repo, dir, branch, target = 'main', message, keyPath } = {}) {
      const key = keyPath ?? keyFor(repo)
      await runGit(['checkout', target], { cwd: dir, keyPath: key, timeoutMs })
      await runGit(['pull', '--ff-only', 'origin', target], { cwd: dir, keyPath: key, timeoutMs })
      await runGit(['-c', 'user.name=tenkrol-agent', '-c', 'user.email=agent@tenkrol.local', 'merge', '--no-ff', branch, '-m', String(message ?? `merge ${branch}`)], { cwd: dir, keyPath: key, timeoutMs })
      await runGit(['push', 'origin', target], { cwd: dir, keyPath: key, timeoutMs })
      const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: dir, timeoutMs })
      return { sha: stdout, target }
    },

    /** Создать PR без API нельзя; возвращаем ссылку на сравнение. */
    prUrl({ repo, branch }) {
      return `https://github.com/${repo}/compare/main...${branch}`
    },
  }
}
