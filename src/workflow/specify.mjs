/**
 * G2: превратить draft заявки в ready-спецификацию через DSH-исследование.
 *
 * DSH работает в ветке spec/<REQ>-<changeId>, изучает затронутый код и заполняет
 * proposal/design/tasks/spec, критерии и вопросы. Публикуется только ветка спеки;
 * код реализации здесь не меняется.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { manifestProblems, REQUEST_STATES } from './request-state.mjs'

const promptFor = ({ requestId, changeId, text }) => `Ты готовишь инженерную спецификацию ${requestId}
для компонента ${changeId}. Это этап ДО реализации: код продукта не меняй.

Изучи затронутый код, существующие OpenSpec и conventions. Заполни в
openspec/changes/${changeId}:
- proposal.md: зачем, наблюдаемое поведение, границы;
- design.md: контракты между компонентами, совместимость, миграции, план выпуска;
- tasks.md: проверяемые задачи;
- specs/<домен>/spec.md: требования и сценарии приёмки.

Требование владельца:
${text}

Не принимай существенные продуктовые решения молча: неопределённости запиши в
questions.md как вопросы владельцу. Не меняй main и не коммить код реализации.`

export function createSpecifyService({ components = [], git, runner, baseDir, loadRequest, runChecks, timeoutMs, logger, maxSteps = 80, tokenBudget = 2_000_000 } = {}) {
  return {
    async specify({ requestId, specRepo, specDir, keyPath, signal }) {
      if (!loadRequest) throw new Error('загрузка заявки не настроена')
      const loaded = await loadRequest({ requestId, specRepo, specDir, keyPath })
      const problems = manifestProblems(loaded.manifest)
      if (problems.length) throw new Error(`manifest невалиден: ${problems.join('; ')}`)
      if (loaded.status?.state === REQUEST_STATES.released || loaded.status?.state === REQUEST_STATES.releasePending) {
        throw new Error('заявка уже выпускается')
      }
      const specs = []
      for (const component of loaded.manifest.components) {
        const target = components.find((item) => item.repository === component.repository)
        if (!target) throw new Error(`нет компонента ${component.repository}`)
        const dir = path.join(baseDir, requestId, 'spec', component.repository.split('/').pop())
        await git.clone({ repo: component.repository, dir, branch: component.branch ?? `spec/${requestId}-${component.changeId}`, keyPath: target.keyPath, fresh: true })
        const result = await runner.run({
          task: promptFor({ requestId, changeId: component.changeId, text: loaded.text }),
          workspaceDir: dir,
          timeoutMs,
          maxSteps,
          tokenBudget,
          signal,
        })
        if (!result?.ok) throw new Error(`DSH не смог подготовить ${component.changeId}: ${String(result?.text ?? result?.error ?? '').slice(0, 300)}`)
        const specChecks = target.specChecks ?? []
        if (specChecks.length > 0 && runChecks) {
          const checks = await runChecks({ root: dir, cwd: dir, commands: specChecks, timeoutMs })
          if ((checks.checks ?? []).some((check) => check.exitCode !== 0 || check.error)) throw new Error(`spec-check не прошёл для ${component.changeId}`)
        }
        const pushed = await git.commitAndPush({
          repo: component.repository,
          dir,
          branch: component.branch ?? `spec/${requestId}-${component.changeId}`,
          message: `${component.changeId}: готовая спецификация ${requestId}`,
          keyPath: target.keyPath,
        })
        specs.push({ repository: component.repository, changeId: component.changeId, branch: component.branch ?? `spec/${requestId}-${component.changeId}`, specificationCommit: pushed.sha })
        logger?.info?.('ready specification published', { requestId, changeId: component.changeId })
      }
      // Согласование должно ссылаться на готовые SHA, а не на исходный каркас.
      const manifestPath = path.join(specDir, 'requests', requestId, 'manifest.json')
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
      manifest.components = (manifest.components ?? []).map((component) => {
        const ready = specs.find((item) => item.repository === component.repository && item.changeId === component.changeId)
        return ready ? { ...component, specificationCommit: ready.specificationCommit } : component
      })
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      const questionsPath = path.join(specDir, 'requests', requestId, 'questions.md')
      const questions = await fs.readFile(questionsPath, 'utf8').catch(() => undefined)
      await fs.writeFile(path.join(specDir, 'requests', requestId, 'status.json'), `${JSON.stringify({
        requestId,
        revision: loaded.manifest.revision,
        state: REQUEST_STATES.ready,
        specs,
        updatedAt: new Date().toISOString(),
        ...(questions ? { questions } : {}),
      }, null, 2)}\n`, 'utf8')
      await git.commitAndPush({ repo: specRepo, dir: specDir, branch: `req/${requestId}`, message: `${requestId}: ready`, keyPath })
      return { requestId, state: REQUEST_STATES.ready, specs, questions }
    },
  }
}
