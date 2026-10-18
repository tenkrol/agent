/**
 * E4: создание заявки из сообщения и публикация ветки в spec-репозиторий.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequestDraft } from './requests.mjs'
import { createGitHubClient } from '../execution/git.mjs'
import { analyzeRequest, draftSpecs } from './analyze.mjs'

const nextId = async (repoDir) => {
  const names = await fs.readdir(path.join(repoDir, 'requests')).catch(() => [])
  const branchDirs = [path.join(repoDir, '.git', 'refs', 'remotes', 'origin', 'req'), path.join(repoDir, '.git', 'refs', 'heads', 'req')]
  for (const branchDir of branchDirs) names.push(...await fs.readdir(branchDir).catch(() => []))
  const packed = await fs.readFile(path.join(repoDir, '.git', 'packed-refs'), 'utf8').catch(() => '')
  for (const match of packed.matchAll(/refs\/remotes\/origin\/req\/(REQ-\d+)/g)) names.push(match[1])
  const numbers = names.map((name) => /^REQ-(\d{4,})/.exec(name)).filter(Boolean).map((match) => Number(match[1]))
  return `REQ-${String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(4, '0')}`
}

export function createRequestService({ repo, repoDir, keyDir = '/etc/agent/github', logger, git = createGitHubClient({ keyDir, logger }), analyze = analyzeRequest, attachComponents } = {}) {
  return {
    /** F2: согласование конкретной ревизии и точных SHA компонентных спек. */
    async approve({ requestId, specRepo, specDir, keyPath, approvedBy = 'owner' } = {}) {
      await git.clone({ repo: specRepo, dir: specDir, branch: `req/${requestId}`, keyPath, fresh: true })
      const dir = path.join(specDir, 'requests', requestId)
      const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'))
      if (!Array.isArray(manifest.components) || manifest.components.length === 0) throw new Error('components пуст: согласовать нечего')
      const approval = {
        requestId,
        revision: manifest.revision,
        approvedBy,
        approvedAt: new Date().toISOString(),
        components: manifest.components.map((component) => ({
          repository: component.repository,
          changeId: component.changeId,
          baseCommit: component.baseCommit,
          specificationCommit: component.specificationCommit,
        })),
      }
      await fs.writeFile(path.join(dir, 'approval.json'), `${JSON.stringify(approval, null, 2)}\n`, 'utf8')
      await fs.writeFile(path.join(dir, 'status.json'), `${JSON.stringify({ requestId, revision: manifest.revision, state: 'approved', updatedAt: approval.approvedAt }, null, 2)}\n`, 'utf8')
      const result = await git.commitAndPush({
        repo: specRepo,
        dir: specDir,
        branch: `req/${requestId}`,
        message: `${requestId}: approved r${manifest.revision}`,
        keyPath,
      })
      logger?.info?.('request approved', { requestId, revision: manifest.revision, sha: result.sha })
      return { requestId, approval, sha: result.sha, compareUrl: result.compareUrl }
    },

    async create({ text, title } = {}) {
      const clean = String(text ?? '').trim()
      if (clean === '') throw new Error('пустой текст заявки')
      const keyPath = path.join(keyDir, `${String(repo).split('/').pop()}_ed25519`)
      await git.clone({ repo, dir: repoDir, branch: 'main', keyPath, fresh: true })
      const requestId = await nextId(repoDir)
      const requestTitle = String(title ?? clean.split('\n')[0]).slice(0, 120)
      const analysis = analyze(clean)
      analysis.specs = draftSpecs(analysis, clean)
      const requestDir = path.join(repoDir, 'requests', requestId)
      await createRequestDraft({
        dir: requestDir,
        requestId,
        title: requestTitle,
        text: clean,
        draft: true,
      })
      await fs.writeFile(path.join(requestDir, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`, 'utf8')
      const branch = `req/${requestId}`
      let attachments = []
      if (attachComponents && !analysis.ambiguous && analysis.components.length > 0) {
        try {
          attachments = await attachComponents({ specs: analysis.specs, requestId, text: clean })
          if (attachments.length > 0) {
            const manifestPath = path.join(requestDir, 'manifest.json')
            const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
            manifest.components = attachments
            await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
          }
        } catch (error) {
          analysis.attachError = String(error?.message ?? error).slice(0, 300)
          logger?.warn?.('component specs not attached', { requestId, error })
        }
      }
      analysis.attachments = attachments
      await fs.writeFile(path.join(requestDir, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`, 'utf8')
      const result = await git.commitAndPush({
        repo,
        dir: repoDir,
        branch,
        message: `${requestId}: ${requestTitle}`,
        keyPath,
      })
      logger?.info?.('request published', { requestId, branch, sha: result.sha })
      return { requestId, branch, sha: result.sha, compareUrl: result.compareUrl, analysis, question: analysis.question }
    },
  }
}
