/**
 * E3: git-транспорт на локальном bare-репозитории (без сети).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { createGitHubClient } from '../src/execution/git.mjs'

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' })

test('commitAndPush writes a branch to a local remote', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'github-'))
  try {
    const remote = path.join(dir, 'remote.git')
    git(dir, ['init', '--bare', remote])
    const seed = path.join(dir, 'seed')
    git(dir, ['clone', remote, 'seed'])
    await fs.writeFile(path.join(seed, 'README.md'), '# seed')
    git(seed, ['add', '.'])
    git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'seed'])
    git(seed, ['branch', '-M', 'main'])
    git(seed, ['push', 'origin', 'main'])
    const client = createGitHubClient({ keyDir: dir, logger: { info() {} } })
    // clone() uses ssh URL; use a plain path clone via commitAndPush on a local copy.
    await fs.cp(seed, path.join(dir, 'work'), { recursive: true })
    const result = await client.commitAndPush({
      repo: 'tenkrol/agent',
      dir: path.join(dir, 'work'),
      branch: 'task-1',
      files: { 'requests/REQ-0001/manifest.json': '{"schemaVersion":1}\n' },
      message: 'test',
      keyPath: undefined,
    })
    assert.match(result.sha, /[0-9a-f]{40}/)
    assert.match(result.compareUrl, /compare\/main\.\.\.task-1/)
    const branches = git(remote, ['branch'])
    assert.match(branches.stdout, /task-1/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
