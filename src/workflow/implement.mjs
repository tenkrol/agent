/**
 * E5: реализация заявки агентом-разработчиком в изолированном checkout.
 *
 * Работает только с ветками: main/production не меняются.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

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

export function createImplementService({ components = [], git, runner, baseDir, timeoutMs, logger, maxSteps = 80, tokenBudget = 800_000 } = {}) {
  return {
    /** Прочитать заявку с ветки req/<requestId>. */
    async loadRequest({ requestId, specRepo, specDir, keyPath }) {
      await git.clone({ repo: specRepo, dir: specDir, branch: `req/${requestId}`, keyPath, fresh: true })
      const manifest = JSON.parse(await fs.readFile(path.join(specDir, 'requests', requestId, 'manifest.json'), 'utf8'))
      const text = await fs.readFile(path.join(specDir, 'requests', requestId, 'request.md'), 'utf8').catch(() => manifest.title ?? '')
      return { requestId, manifest, text }
    },

    /** Реализовать все компоненты заявки; ошибка одного останавливает поток. */
    async implement({ requestId, specRepo, specDir, keyPath, signal }) {
      const loaded = await this.loadRequest({ requestId, specRepo, specDir, keyPath })
      const results = []
      for (const component of loaded.manifest.components ?? []) {
        const target = components.find((item) => item.repository === component.repository)
        if (!target) throw new Error(`нет настроенного компонента ${component.repository}`)
        const dir = path.join(baseDir, requestId, component.repository.split('/').pop())
        await git.clone({ repo: component.repository, dir, branch: component.branch ?? 'main', keyPath: target.keyPath, fresh: true })
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
        })
        logger?.info?.('request implemented', { requestId, changeId: component.changeId, branch })
      }
      return { requestId, results }
    },
  }
}
