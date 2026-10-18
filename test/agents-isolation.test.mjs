/**
 * E1: реестр агентов, fresh session, retention и лимит задач пользователя.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createExecutorRegistry } from '../src/orchestration/registry.mjs'
import { createDshExecutor } from '../src/agents/dsh/index.mjs'
import { prepareTaskWorkspace, pruneTaskWorkspaces, taskWorkspacePath } from '../src/execution/workspace.mjs'

test('registry describes limits, model profile and tools', () => {
  const executor = createDshExecutor({ runner: { run: async () => ({}) }, limits: { maxSteps: 5 }, modelProfile: 'deepseek-flash', tools: ['git'] })
  const registry = createExecutorRegistry({ executors: [executor] })
  const [info] = registry.describe()
  assert.equal(info.id, 'dsh')
  assert.deepEqual(info.limits, { maxSteps: 5 })
  assert.equal(info.modelProfile, 'deepseek-flash')
  assert.deepEqual(info.tools, ['git'])
})

test('retention removes only old task workspaces that are not active', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'retention-'))
  try {
    const old = await prepareTaskWorkspace(base, 'old', { perTask: true })
    const active = await prepareTaskWorkspace(base, 'active', { perTask: true })
    const past = Date.now() - 60 * 24 * 3600 * 1000
    await fs.utimes(old, past / 1000, past / 1000)
    const removed = await pruneTaskWorkspaces(base, { retentionDays: 14, activeIds: ['active'] })
    assert.equal(removed, 1)
    await assert.rejects(() => fs.stat(old))
    assert.equal(await fs.stat(active).then((stat) => stat.isDirectory()), true)
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

import { createBotHarness } from './helpers.mjs'

test('per-task workspace starts a fresh DSH session for a new task', async () => {
  const sessions = []
  const env = await createBotHarness({
    configEnv: { WORKSPACE_PER_TASK: 'true', PLAN_MODE: 'never' },
    runner: { async run({ sessionId }) { sessions.push(sessionId); return { ok: true, text: 'ok', sessionId: 's', usage: { totalTokens: 1, steps: 1 }, durationMs: 1 } } },
  })
  try {
    await env.bot.submitBridgedTask({ task: 'первая задача', source: 'test', requestId: 'fresh-1' })
    await env.bot.worker
    await env.bot.submitBridgedTask({ task: 'вторая задача', source: 'test', requestId: 'fresh-2' })
    await env.bot.worker
    assert.equal(sessions[0], undefined)
    assert.equal(sessions[1], undefined, 'новый per-task запуск не наследует сессию чата')
  } finally {
    await env.close()
  }
})

test('per-user concurrency limit rejects a second unfinished task', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const env = await createBotHarness({
    configEnv: { TASK_PER_USER_CONCURRENCY: '1', PLAN_MODE: 'never' },
    runner: { async run() { await gate; return { ok: true, text: 'ok', usage: { totalTokens: 1, steps: 1 }, durationMs: 1 } } },
  })
  try {
    const first = await env.bot.submitBridgedTask({ task: 'долгая задача', source: 'test', requestId: 'conc-1' })
    assert.ok(first.taskId)
    await new Promise((resolve) => setTimeout(resolve, 10))
    await assert.rejects(
      () => env.bot.submitBridgedTask({ task: 'вторая задача', source: 'test', requestId: 'conc-2' }),
      /лимит задач пользователя/,
    )
    release()
    await env.bot.worker
  } finally {
    release?.()
    await env.close()
  }
})
