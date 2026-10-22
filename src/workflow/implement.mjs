/**
 * E5: реализация заявки агентом-разработчиком в изолированном checkout.
 *
 * Работает только с ветками: main/production не меняются.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { runCodeChecks } from '../execution/checks.mjs'
import { REQUEST_STATES, validateImplementable } from './request-state.mjs'

const promptFor = ({ requestId, changeId, text, branch }) => `Ты реализуешь заявку ${requestId}
в компоненте ${changeId} на ветке ${branch}.

Требование:
${text}

Правила:
- меняй только этот репозиторий и только в рамках change ${changeId};
- следуй openspec/conventions.md и AGENTS.md;
- добавь/обнови тесты и документы изменения;
- не делай merge в main, не меняй секреты и чужие репозитории;
- если изменение уже реализовано, ничего не коммить;
- в конце коротко перечисли изменённые файлы и проверки.`

export function createImplementService({ components = [], git, runner, baseDir, timeoutMs, logger, maxSteps = 100, tokenBudget = 2_500_000, maxRepairs = 2, runChecks = runCodeChecks } = {}) {
  const throwIfCancelled = (signal) => {
    if (signal?.aborted) throw Object.assign(new Error('реализация отменена'), { name: 'AbortError', code: 'ABORT_ERR' })
  }
  return {
    /** Прочитать заявку с ветки req/<requestId>. */
    async loadRequest({ requestId, specRepo, specDir, keyPath }) {
      await git.clone({ repo: specRepo, dir: specDir, branch: `req/${requestId}`, keyPath, fresh: true })
      const manifest = JSON.parse(await fs.readFile(path.join(specDir, 'requests', requestId, 'manifest.json'), 'utf8'))
      const text = await fs.readFile(path.join(specDir, 'requests', requestId, 'request.md'), 'utf8').catch(() => manifest.title ?? '')
      const approval = await fs.readFile(path.join(specDir, 'requests', requestId, 'approval.json'), 'utf8').then((raw) => JSON.parse(raw)).catch(() => undefined)
      const status = await fs.readFile(path.join(specDir, 'requests', requestId, 'status.json'), 'utf8').then((raw) => JSON.parse(raw)).catch(() => undefined)
      return { requestId, manifest, text, approval, status }
    },

    /** Записать состояние заявки в её ветку. */
    async saveStatus({ requestId, specRepo, specDir, keyPath, state, extra = {} }) {
      const file = path.join(specDir, 'requests', requestId, 'status.json')
      const status = { requestId, state, updatedAt: new Date().toISOString(), ...extra }
      await fs.writeFile(file, `${JSON.stringify(status, null, 2)}\n`, 'utf8')
      await git.commitAndPush({
        repo: specRepo,
        dir: specDir,
        branch: `req/${requestId}`,
        message: `${requestId}: ${state}`,
        keyPath,
      })
      return status
    },

    /** Реализовать все компоненты заявки; ошибка одного останавливает поток. */
    async implement({ requestId, specRepo, specDir, keyPath, signal, retry = false }) {
      const loaded = await this.loadRequest({ requestId, specRepo, specDir, keyPath })
      const check = validateImplementable({ manifest: loaded.manifest, approval: loaded.approval, status: loaded.status, retry })
      if (!check.ok) throw new Error(`заявка не готова к реализации: ${check.errors.join('; ')}`)
      await this.saveStatus({ requestId, specRepo, specDir, keyPath, state: REQUEST_STATES.running, extra: { revision: loaded.manifest.revision } })
      const results = []
      try {
      for (const component of loaded.manifest.components ?? []) {
        throwIfCancelled(signal)
        const target = components.find((item) => item.repository === component.repository)
        if (!target) throw new Error(`нет настроенного компонента ${component.repository}`)
        const dir = path.join(baseDir, requestId, component.repository.split('/').pop())
        await git.clone({ repo: component.repository, dir, branch: component.branch ?? 'main', keyPath: target.keyPath, fresh: true })
        if (!component.specificationCommit) throw new Error(`нет specificationCommit для ${component.changeId}`)
        await git.checkoutCommit({ repo: component.repository, dir, sha: component.specificationCommit, keyPath: target.keyPath })
        const branch = `impl/${requestId}-${component.changeId}`
        const result = await runner.run({
          task: promptFor({ requestId, changeId: component.changeId, text: loaded.text, branch: component.branch }),
          workspaceDir: dir,
          timeoutMs,
          maxSteps,
          tokenBudget,
          signal,
        })
        if (!result?.ok) throw new Error(`DSH не смог реализовать ${component.changeId}: ${String(result?.text ?? result?.error ?? '').slice(0, 300)}`)
        throwIfCancelled(signal)
        let checks = await runChecks({ root: dir, cwd: dir, commands: target.checks ?? [], timeoutMs, signal })
        throwIfCancelled(signal)
        let repairs = 0
        const failed = (result) => (result.checks ?? []).some((check) => check.exitCode !== 0 || check.error)
        while (failed(checks) && repairs < maxRepairs) {
          const failures = (checks.checks ?? []).filter((check) => check.exitCode !== 0 || check.error)
            .map((check) => `$ ${check.command}\n${check.stdout ?? ''}\n${check.stderr ?? ''}`).join('\n\n').slice(-4000)
          const repaired = await runner.run({
            task: `Исправь ошибки проверок в ${component.changeId} (${requestId}).\n\n${failures}`,
            workspaceDir: dir,
            timeoutMs,
            maxSteps,
            tokenBudget,
            signal,
          })
          repairs += 1
          if (!repaired?.ok) break
          throwIfCancelled(signal)
          checks = await runChecks({ root: dir, cwd: dir, commands: target.checks ?? [], timeoutMs, signal })
          throwIfCancelled(signal)
        }
        if (failed(checks)) throw new Error(`проверки не прошли: ${(checks.checks ?? []).filter((check) => check.exitCode !== 0 || check.error).map((check) => check.command).join(', ')}`)
        throwIfCancelled(signal)
        const pushed = await git.commitAndPush({
          repo: component.repository,
          dir,
          branch,
          message: `${component.changeId}: реализация ${requestId}`,
          keyPath: target.keyPath,
        })
        results.push({
          repository: component.repository,
          changeId: component.changeId,
          branch,
          specificationCommit: component.specificationCommit,
          implementationCommit: pushed.sha,
          compareUrl: pushed.compareUrl,
          runner: { steps: result.usage?.steps, tokens: result.usage?.totalTokens },
          checks: (checks.checks ?? []).map((check) => ({ command: check.command, exitCode: check.exitCode })),
          repairs,
        })
        logger?.info?.('request implemented', { requestId, changeId: component.changeId, branch })
      }
      } catch (error) {
        const cancelled = signal?.aborted || error?.name === 'AbortError'
        await this.saveStatus({
          requestId,
          specRepo,
          specDir,
          keyPath,
          state: cancelled ? REQUEST_STATES.cancelled : REQUEST_STATES.failed,
          extra: { error: String(error?.message ?? error).slice(0, 300) },
        }).catch(() => {})
        throw error
      }
      throwIfCancelled(signal)
      await this.saveStatus({
        requestId,
        specRepo,
        specDir,
        keyPath,
        state: REQUEST_STATES.verified,
        extra: { revision: loaded.manifest.revision, results },
      })
      return { requestId, results, state: REQUEST_STATES.verified }
    },
  }
}
