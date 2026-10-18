/**
 * 3.2: детерминированные наблюдатели с реестром источников.
 *
 * Источник не скрывает сбой: unavailable — отдельный статус, а не пустой findings.
 */
export function createObserverRegistry({ sources = [], now = () => Date.now(), logger } = {}) {
  const last = new Map()

  async function observe({ signal } = {}) {
    const at = now()
    const report = []
    const findings = []
    for (const source of sources) {
      if (signal?.aborted) break
      try {
        const evidence = await source.read({ signal })
        const previous = last.get(source.id)
        last.set(source.id, { at, evidence })
        report.push({ id: source.id, kind: source.kind, status: 'ok', checkedAt: at, freshAt: at, evidence })
        if (previous && JSON.stringify(previous.evidence) !== JSON.stringify(evidence)) {
          findings.push({ source: source.id, kind: source.kind, at, previous: previous.evidence, evidence })
        }
      } catch (error) {
        report.push({ id: source.id, kind: source.kind, status: 'unavailable', checkedAt: at, freshAt: last.get(source.id)?.at, error: String(error?.message ?? error).slice(0, 300) })
        logger?.warn?.('observer source unavailable', { source: source.id, error })
      }
    }
    return { at, sources: report, findings }
  }

  return { observe, sources: () => sources.map((source) => ({ id: source.id, kind: source.kind })) }
}

/** GitHub-источник: последний известный коммит каждого репозитория. */
export function createGithubSource({ id = 'github', git, repos = [], keyPathFor = () => undefined, dirRoot }) {
  return {
    id,
    kind: 'github',
    async read() {
      const evidence = []
      for (const repo of repos) {
        const dir = `${dirRoot}/${repo.split('/').pop()}`
        await git.clone({ repo, dir, branch: 'main', keyPath: keyPathFor(repo), fresh: true })
        const sha = await git.head({ dir })
        evidence.push({ repo, sha })
      }
      return evidence
    },
  }
}

/** Серверный источник: произвольный probe-порт возвращает наблюдаемые факты. */
export function createServerSource({ id = 'server', probe } = {}) {
  return { id, kind: 'server', async read() { return probe() } }
}
