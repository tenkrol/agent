/**
 * G1: детерминированный почасовой опрос ready-заявок.
 *
 * Без LLM. Источник — ветки req/<REQ> spec-репозитория: manifest, approval, status.
 * Готовность: approval есть, состояние approved/ready, реализация ещё не running/verified.
 * onReady ставит устойчивую операцию в существующую очередь агента.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { approvalProblems, manifestProblems, REQUEST_STATES } from './request-state.mjs'

export function createRequestPoller({ git, repo, dir, keyPath, intervalMs = 3_600_000, onReady, logger, now = () => Date.now() } = {}) {
  const state = { nextPollAt: undefined, lastPollAt: undefined, lastError: undefined, lastFound: 0, lastEnqueued: 0, lastResults: [] }
  let timer

  async function scan() {
    state.lastPollAt = now()
    try {
      await git.clone({ repo, dir, branch: 'main', keyPath, fresh: true })
      await git.fetchRequests({ repo, dir, keyPath })
      const refs = await git.refs({ dir })
      const found = []
      for (const ref of refs) {
        const requestId = String(ref).split('/').pop()
        if (!/^REQ-\d{4,}$/.test(requestId)) continue
        const read = async (file) => git.show({ dir, ref, path: `requests/${requestId}/${file}` }).then((raw) => JSON.parse(raw)).catch(() => undefined)
        const manifest = await read('manifest.json')
        const approval = await read('approval.json')
        const status = await read('status.json')
        if (!manifest) continue
        const problems = [...manifestProblems(manifest), ...approvalProblems(manifest, approval)]
        if (problems.length) continue
        const current = status?.state
        if (current === REQUEST_STATES.running || current === REQUEST_STATES.verified || current === REQUEST_STATES.releasePending || current === REQUEST_STATES.released) continue
        if (current && ![REQUEST_STATES.approved, REQUEST_STATES.ready].includes(current)) continue
        found.push({ requestId, revision: manifest.revision, components: manifest.components, ref })
      }
      state.lastFound = found.length
      let enqueued = 0
      for (const request of found) {
        try {
          const outcome = await onReady?.(request)
          if (outcome?.queued) enqueued += 1
          state.lastResults.push({ requestId: request.requestId, revision: request.revision, queued: Boolean(outcome?.queued), reason: outcome?.reason })
        } catch (error) {
          state.lastResults.push({ requestId: request.requestId, error: String(error?.message ?? error).slice(0, 200) })
        }
      }
      state.lastEnqueued = enqueued
      state.lastError = undefined
      state.nextPollAt = now() + intervalMs
      return { found, enqueued, results: state.lastResults }
    } catch (error) {
      state.lastError = String(error?.message ?? error).slice(0, 300)
      state.nextPollAt = now() + intervalMs
      logger?.warn?.('request poll failed', { error })
      throw error
    }
  }

  return {
    scan,
    status: () => ({ ...state, lastResults: [...state.lastResults].slice(-20) }),
    start() {
      if (timer) return
      void scan().catch(() => {})
      timer = setInterval(() => { void scan().catch(() => {}) }, intervalMs)
    },
    stop() { if (timer) clearInterval(timer); timer = undefined },
  }
}
