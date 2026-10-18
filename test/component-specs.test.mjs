import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createComponentSpecService } from '../src/workflow/component-specs.mjs'

test('component spec service allocates the next changeId and writes an OpenSpec draft', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'component-spec-'))
  try {
    const repoDir = path.join(root, 'agent')
    await fs.mkdir(path.join(repoDir, 'openspec', 'changes', 'PLA-27'), { recursive: true })
    const calls = []
    const service = createComponentSpecService({
      components: [{ repository: 'tenkrol/agent', dir: repoDir, keyPath: '/tmp/key', domain: 'workflow' }],
      logger: { info() {} },
      git: {
        async clone() { return { dir: repoDir, sha: 'a'.repeat(40) } },
        async commitAndPush(options) { calls.push(options); return { sha: 'b'.repeat(40), compareUrl: 'https://example/compare' } },
      },
    })
    const attached = await service.attach({
      requestId: 'REQ-0007',
      text: 'Добавь команду',
      specs: [{ repository: 'tenkrol/agent', changePrefix: 'PLA', proposal: '# PLA-TBD\n', design: '# D\n', tasks: '# T\n' }],
    })
    assert.equal(attached[0].changeId, 'PLA-28')
    assert.equal(attached[0].branch, 'spec/REQ-0007-PLA-28')
    assert.equal(calls.length, 1)
    const spec = await fs.readFile(path.join(repoDir, 'openspec', 'changes', 'PLA-28', 'specs', 'workflow', 'spec.md'), 'utf8')
    assert.match(spec, /ADDED Requirements/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
