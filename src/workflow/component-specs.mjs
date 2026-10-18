/**
 * E4: запись компонентных OpenSpec-черновиков в репозитории компонентов.
 *
 * В main ничего не пишется: каждая спека уходит в ветку `spec/<REQ>-<changeId>`.
 * Номера changeId берутся из openspec/changes и archive, чтобы не переиспользовать
 * уже занятые в текущей ветке.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const prefixOf = (repository) => String(repository).endsWith('/assistant') ? 'PLB' : 'PLA'

async function nextNumber(repoDir, prefix) {
  const roots = [path.join(repoDir, 'openspec', 'changes'), path.join(repoDir, 'openspec', 'changes', 'archive')]
  const numbers = []
  for (const root of roots) {
    const entries = await fs.readdir(root).catch(() => [])
    for (const name of entries) {
      const match = new RegExp(`^${prefix}-(\\d+)$`).exec(name)
      if (match) numbers.push(Number(match[1]))
    }
  }
  return (numbers.length ? Math.max(...numbers) : 0) + 1
}

const specDocument = ({ changeId, title, text, prefix }) => `# Дельта для домена

## ADDED Requirements

### Requirement: ${title}

${String(text ?? '').trim()}

#### Scenario: Черновик E4
- GIVEN заявка ${changeId} принята
- WHEN изменение реализовано
- THEN поведение соответствует заявке
`

export function createComponentSpecService({ components, git, logger } = {}) {
  return {
    /** components: [{repository, dir, keyPath, domain}] */
    async attach({ specs = [], requestId, text = '' }) {
      const attached = []
      for (const spec of specs) {
        const component = (components ?? []).find((item) => item.repository === spec.repository)
        if (!component) throw new Error(`нет компонента ${spec.repository}`)
        const prefix = spec.changePrefix ?? prefixOf(spec.repository)
        await git.clone({ repo: spec.repository, dir: component.dir, branch: 'main', keyPath: component.keyPath, fresh: true })
        const number = await nextNumber(component.dir, prefix)
        const changeId = `${prefix}-${number}`
        const title = String(text || 'Доработка').split('\n')[0].slice(0, 100)
        const changeDir = path.join(component.dir, 'openspec', 'changes', changeId)
        await fs.mkdir(path.join(changeDir, 'specs', component.domain), { recursive: true })
        await fs.writeFile(path.join(changeDir, 'proposal.md'), spec.proposal.replace(`${prefix}-TBD`, changeId), 'utf8')
        await fs.writeFile(path.join(changeDir, 'design.md'), spec.design, 'utf8')
        await fs.writeFile(path.join(changeDir, 'tasks.md'), spec.tasks, 'utf8')
        await fs.writeFile(path.join(changeDir, 'specs', component.domain, 'spec.md'), specDocument({ changeId, title, text, prefix }), 'utf8')
        const branch = `spec/${requestId}-${changeId}`
        const result = await git.commitAndPush({
          repo: spec.repository,
          dir: component.dir,
          branch,
          message: `${changeId}: ${title} (${requestId})`,
          keyPath: component.keyPath,
        })
        logger?.info?.('component spec published', { requestId, repository: spec.repository, changeId, branch })
        attached.push({
          repository: spec.repository,
          changeId,
          baseCommit: (await git.clone({ repo: spec.repository, dir: component.dir, branch: 'main', keyPath: component.keyPath })).sha,
          specificationCommit: result.sha,
          branch,
          compareUrl: result.compareUrl,
        })
      }
      return attached
    },
  }
}
