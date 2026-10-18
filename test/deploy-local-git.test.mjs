/**
 * F3: проверка на реальных временных Git-репозиториях, а не только заглушках.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { createDeployService } from '../src/workflow/deploy.mjs'

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function localGit() {
  return {
    async clone({ dir, branch = 'main', fresh = false } = {}) {
      if (fresh) await fs.rm(dir, { recursive: true, force: true })
      await fs.mkdir(path.dirname(dir), { recursive: true })
      git(path.dirname(dir), ['clone', '-q', '--branch', branch, dir.remote, dir])
      return { sha: git(dir, ['rev-parse', 'HEAD']) }
    },
    async checkoutCommit({ dir, sha }) {
      git(dir, ['fetch', '-q', 'origin', sha])
      git(dir, ['checkout', '-q', sha])
      return git(dir, ['rev-parse', 'HEAD'])
    },
    async head({ dir }) { return git(dir, ['rev-parse', 'HEAD']) },
    async mergeSha({ dir, sha }) {
      git(dir, ['fetch', '-q', 'origin', sha])
      git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '--no-ff', sha, '-m', 'integration'])
      return git(dir, ['rev-parse', 'HEAD'])
    },
    async push({ dir, target = 'main' }) {
      git(dir, ['push', '-q', 'origin', `${target}`])
      return git(dir, ['rev-parse', 'HEAD'])
    },
  }
}

async function makeRepos() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-git-'))
  const remote = path.join(root, 'agent.git')
  git(root, ['init', '-q', '--bare', remote])
  const seed = path.join(root, 'seed')
  git(root, ['clone', '-q', remote, seed])
  await fs.writeFile(path.join(seed, 'README.md'), '# seed\n')
  git(seed, ['add', '.'])
  git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed'])
  git(seed, ['branch', '-M', 'main'])
  git(seed, ['push', '-q', 'origin', 'main'])
  const spec = git(seed, ['rev-parse', 'HEAD'])
  git(seed, ['checkout', '-q', '-b', 'spec/REQ-0009-PLA-99'])
  await fs.writeFile(path.join(seed, 'CHANGE.md'), 'change\n')
  git(seed, ['add', '.'])
  git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'spec'])
  const specSha = git(seed, ['rev-parse', 'HEAD'])
  git(seed, ['push', '-q', 'origin', 'spec/REQ-0009-PLA-99'])
  git(seed, ['checkout', '-q', '-b', 'impl/REQ-0009-PLA-99'])
  await fs.writeFile(path.join(seed, 'impl.txt'), 'impl\n')
  git(seed, ['add', '.'])
  git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'impl'])
  const implSha = git(seed, ['rev-parse', 'HEAD'])
  git(seed, ['push', '-q', 'origin', 'impl/REQ-0009-PLA-99'])
  return { root, remote, seed, specSha, implSha }
}

const manifestFor = ({ specSha, implSha }) => ({
  requestId: 'REQ-0009', revision: 1,
  components: [{ repository: 'tenkrol/agent', changeId: 'PLA-99', baseCommit: specSha, specificationCommit: specSha, branch: 'spec/REQ-0009-PLA-99' }],
})
const approvalFor = (manifest) => ({ requestId: manifest.requestId, revision: 1, approvedBy: 'owner', approvedAt: '2026-10-18T20:00:00.000Z', components: manifest.components })
const statusFor = (implSha) => ({ requestId: 'REQ-0009', revision: 1, state: 'verified', results: [{ repository: 'tenkrol/agent', changeId: 'PLA-99', branch: 'impl/REQ-0009-PLA-99', specificationCommit: 'b'.repeat(40), implementationCommit: implSha }] })

test('real Git: deploy publishes the merge result it checked', async () => {
  const fixtures = await makeRepos()
  try {
    const manifest = manifestFor(fixtures)
    const adapter = localGit()
    adapter.clone = async (options) => {
      // dir.remote is not passed by service, so map repository to the local bare repo.
      return localGit().clone({ ...options, dir: options.dir, branch: options.branch, fresh: options.fresh })
    }
    // Patch remote resolution: service passes repository only, so attach it.
    const gitWithRemote = {
      ...adapter,
      async clone({ dir, branch = 'main', fresh = false }) {
        if (fresh) await fs.rm(dir, { recursive: true, force: true })
        await fs.mkdir(path.dirname(dir), { recursive: true })
        git(path.dirname(dir), ['clone', '-q', '--branch', branch, fixtures.remote, dir])
        return { sha: git(dir, ['rev-parse', 'HEAD']) }
      },
    }
    const service = createDeployService({
      components: [{ repository: 'tenkrol/agent', keyPath: '/tmp/key', checks: [] }],
      git: gitWithRemote,
      loadRequest: async () => ({ manifest, approval: approvalFor(manifest), status: statusFor(fixtures.implSha) }),
      baseDir: path.join(fixtures.root, 'work'),
      checks: async () => ({ checks: [{ command: 'none', exitCode: 0 }] }),
      logger: { info() {} },
    })
    const result = await service.deploy({ requestId: 'REQ-0009', component: 'tenkrol/agent', branch: 'impl/REQ-0009-PLA-99', confirm: 'REQ-0009' })
    assert.equal(result.publishedSha, result.mergedSha)
    assert.equal(git(fixtures.remote, ['rev-parse', 'main']), result.mergedSha)
    assert.match(git(fixtures.remote, ['log', '--oneline', 'main']), /impl|integration/)
  } finally {
    await fs.rm(fixtures.root, { recursive: true, force: true })
  }
})
