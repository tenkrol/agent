/**
 * E7: установка проверенной реализации после подтверждения владельца.
 *
 * Ничего не устанавливает сам: установщик компонента приходит портом `install`.
 */
export function createDeployService({ components = [], git, checks, install, logger } = {}) {
  return {
    async deploy({ requestId, component, branch, confirm } = {}) {
      if (!requestId || confirm !== requestId) throw new Error('нужно подтверждение: confirm должен совпадать с requestId')
      const target = components.find((item) => item.repository === component)
      if (!target) throw new Error(`нет компонента ${component}`)
      const verified = await checks({ repository: component, branch })
      if (!verified?.ok) throw new Error('проверки не зелёные: деплой отменён')
      await git.clone({ repo: component, dir: target.dir, branch, keyPath: target.keyPath, fresh: true })
      const merged = await git.mergeAndPush({
        repo: component,
        dir: target.dir,
        branch,
        target: 'main',
        message: `deploy ${requestId}: merge ${branch}`,
        keyPath: target.keyPath,
      })
      const installed = install
        ? await install({ repository: component, sha: merged.sha, requestId })
        : { required: true, command: 'bash deploy/install-remote.sh (запуск владельцем/root)' }
      logger?.info?.('component deployed', { requestId, component, sha: merged.sha })
      return { requestId, component, sha: merged.sha, installed }
    },
  }
}
