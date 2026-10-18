/**
 * F3: выпуск только проверенного результата интеграции.
 *
 * Идентификатор проверенного кода — commit SHA, а не имя ветки. Merge выполняется
 * с актуальным main; проверки запускаются на результате слияния; публикация — после
 * зелёных проверок. Установка — отдельное состояние, не «успех merge».
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { runCodeChecks } from '../execution/checks.mjs'
import { approvalProblems, manifestProblems, REQUEST_STATES } from './request-state.mjs'

const SHA = /^[0-9a-f]{40}$/i

export function createDeployService({ components = [], git, loadRequest, baseDir, checks: runChecks = runCodeChecks, install, rollback, logger, timeoutMs = 900_000 } = {}) {
  const pendingInstalls = new Map()
  return {
    async deploy({ requestId, component, branch, confirm, specRepo, specDir, keyPath } = {}) {
      if (!requestId || confirm !== requestId) throw new Error('нужно подтверждение: confirm должен совпадать с requestId')
      if (!loadRequest) throw new Error('загрузка заявки не настроена')
      const loaded = await loadRequest({ requestId, specRepo, specDir, keyPath })
      const { manifest, approval, status } = loaded
      const problems = [...manifestProblems(manifest), ...approvalProblems(manifest, approval)]
      if (problems.length) throw new Error(`заявка не готова к выпуску: ${problems.join('; ')}`)
      if (status?.state !== REQUEST_STATES.verified) throw new Error(`выпуск разрешён только из verified, сейчас ${status?.state ?? 'нет статуса'}`)
      if (Number(status.revision) !== Number(manifest.revision)) throw new Error('статус относится к другой ревизии заявки')
      const result = (status.results ?? []).find((item) => item.repository === component)
      if (!result) throw new Error(`в проверенной реализации нет ${component}`)
      if (branch !== result.branch) throw new Error('ветка не принадлежит проверенной реализации заявки')
      if (!SHA.test(result.implementationCommit ?? '')) throw new Error('implementationCommit не SHA')
      const target = components.find((item) => item.repository === component)
      if (!target) throw new Error(`нет компонента ${component}`)

      const implDir = path.join(baseDir, requestId, 'impl', component.split('/').pop())
      await git.clone({ repo: component, dir: implDir, branch: result.branch, keyPath: target.keyPath, fresh: true })
      await git.checkoutCommit({ repo: component, dir: implDir, sha: result.implementationCommit, keyPath: target.keyPath })
      const checked = await git.head({ dir: implDir })
      if (checked !== result.implementationCommit) throw new Error('checkout не совпал с проверенным SHA')

      // Интеграция с актуальным main: проверяем именно результат слияния.
      const integrationDir = path.join(baseDir, requestId, 'integration', component.split('/').pop())
      await git.clone({ repo: component, dir: integrationDir, branch: 'main', keyPath: target.keyPath, fresh: true })
      const mergedSha = await git.mergeSha({ repo: component, dir: integrationDir, sha: result.implementationCommit, keyPath: target.keyPath })
      const checks = await runChecks({ root: integrationDir, cwd: integrationDir, commands: target.checks ?? [], timeoutMs })
      const failed = (checks.checks ?? []).filter((check) => check.exitCode !== 0 || check.error)
      if (failed.length) throw new Error(`проверки результата слияния не прошли: ${failed.map((check) => check.command).join(', ')}`)

      const publishedSha = await git.push({ repo: component, dir: integrationDir, target: 'main', keyPath: target.keyPath })
      if (publishedSha !== mergedSha) throw new Error('опубликован не тот commit, который проверялся')

      let installed = { state: 'installation_required', required: true, command: 'bash deploy/install-remote.sh (владелец/root)' }
      if (install) {
        try {
          installed = await install({ repository: component, sha: publishedSha, requestId })
          if (!installed?.healthy) {
            await rollback?.({ repository: component, sha: publishedSha, requestId, reason: 'healthcheck failed' })
            installed = { ...installed, state: 'rolled_back', ok: false }
          } else {
            installed = { ...installed, state: 'healthy', ok: true }
          }
        } catch (error) {
          await rollback?.({ repository: component, sha: publishedSha, requestId, reason: String(error?.message ?? error) })
          installed = { state: 'rolled_back', ok: false, error: String(error?.message ?? error).slice(0, 200) }
        }
      }
      if (specDir) await fs.writeFile(path.join(specDir, 'requests', requestId, 'release.json'), `${JSON.stringify({
        requestId, revision: manifest.revision, component, branch: result.branch,
        implementationCommit: result.implementationCommit, mergedSha, checkedSha: mergedSha, publishedSha,
        installed, at: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8').catch(() => {})
      pendingInstalls.set(`${requestId}:${component}`, { mergedSha, publishedSha, at: new Date().toISOString() })
      logger?.info?.('verified integration published', { requestId, component, mergedSha, installed: installed.state })
      return {
        requestId,
        component,
        implementationCommit: result.implementationCommit,
        mergedSha,
        checkedSha: mergedSha,
        publishedSha,
        installed,
        states: { merged: true, installation_required: installed.state === 'installation_required', installing: false, healthy: installed.state === 'healthy' },
      }
    },

    /** Ручная установка: подтвердить SHA и healthcheck, не выдавая merge за install. */
    reportInstalled({ requestId, component, sha, healthy = false, release } = {}) {
      const pending = pendingInstalls.get(`${requestId}:${component}`)
      if (!pending) throw new Error('нет ожидающей установки для этой заявки')
      if (sha !== pending.publishedSha || sha !== pending.mergedSha) throw new Error('SHA установки не совпадает с проверенным publishedSha')
      const result = { requestId, component, sha, state: healthy ? 'healthy' : 'installed_unhealthy', healthy: Boolean(healthy), release, at: new Date().toISOString() }
      if (healthy) pendingInstalls.delete(`${requestId}:${component}`)
      return result
    },
  }
}
