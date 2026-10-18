/**
 * F2: проверяемый жизненный цикл заявки.
 *
 * Состояния и допустимые переходы; согласование привязано к revision заявки и
 * точным SHA компонентных спецификаций. Изменение SHA отменяет согласование.
 */
export const REQUEST_STATES = Object.freeze({
  draft: 'draft',
  approved: 'approved',
  ready: 'ready',
  running: 'running',
  verified: 'verified',
  releasePending: 'release_pending',
  released: 'released',
  failed: 'failed',
  cancelled: 'cancelled',
})

const TRANSITIONS = {
  draft: ['approved', 'cancelled'],
  approved: ['ready', 'running', 'cancelled', 'failed'],
  ready: ['running', 'cancelled', 'failed'],
  running: ['verified', 'failed', 'cancelled'],
  verified: ['release_pending', 'running', 'failed', 'cancelled'],
  release_pending: ['released', 'failed', 'cancelled'],
  released: [],
  failed: ['running', 'cancelled'],
  cancelled: ['running'],
}

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to))
}

const SHA = /^[0-9a-f]{40}$/i
const pad = (component) => `${component?.repository}:${component?.changeId}`

export function normalizedComponents(components = []) {
  return components.map((component) => ({
    repository: component.repository,
    changeId: component.changeId,
    baseCommit: component.baseCommit,
    specificationCommit: component.specificationCommit,
    branch: component.branch,
  }))
}

/** Ошибки манифеста: пустой/битый список компонентов не считается успехом. */
export function manifestProblems(manifest) {
  const problems = []
  if (!manifest || typeof manifest !== 'object') return ['manifest отсутствует']
  if (!Array.isArray(manifest.components) || manifest.components.length === 0) problems.push('components пуст')
  for (const [index, component] of (manifest.components ?? []).entries()) {
    for (const field of ['repository', 'changeId', 'baseCommit', 'specificationCommit']) {
      if (!component?.[field]) problems.push(`components[${index}].${field} отсутствует`)
    }
    if (component?.baseCommit && !SHA.test(component.baseCommit)) problems.push(`components[${index}].baseCommit не SHA`)
    if (component?.specificationCommit && !SHA.test(component.specificationCommit)) problems.push(`components[${index}].specificationCommit не SHA`)
  }
  return problems
}

/** Согласование совпадает с revision и точными SHA компонентов. */
export function approvalProblems(manifest, approval) {
  if (!approval) return ['нет согласования']
  const problems = []
  if (approval.requestId !== manifest.requestId) problems.push('approval.requestId не совпадает')
  if (Number(approval.revision) !== Number(manifest.revision)) problems.push('approval.revision не совпадает')
  if (!approval.approvedBy) problems.push('approval.approvedBy отсутствует')
  if (!approval.approvedAt) problems.push('approval.approvedAt отсутствует')
  const approved = new Map((approval.components ?? []).map((component) => [pad(component), component]))
  for (const component of manifest.components ?? []) {
    const match = approved.get(pad(component))
    if (!match) problems.push(`согласование не содержит ${pad(component)}`)
    else if (match.specificationCommit !== component.specificationCommit) problems.push(`SHA спецификации ${pad(component)} изменён после согласования`)
  }
  if (approved.size !== (manifest.components ?? []).length) problems.push('согласованы лишние компоненты')
  return problems
}

/**
 * Можно ли запускать реализацию.
 *
 * @param {object} input - manifest/approval/status/retry.
 * @returns {{ok: boolean, state: string, errors: string[]}}
 */
export function validateImplementable({ manifest, approval, status, retry = false } = {}) {
  const errors = [...manifestProblems(manifest)]
  if (errors.length > 0) return { ok: false, state: status?.state ?? 'draft', errors }
  errors.push(...approvalProblems(manifest, approval))
  const state = status?.state ?? (approval ? REQUEST_STATES.ready : REQUEST_STATES.draft)
  if (state === REQUEST_STATES.running && !retry) errors.push('заявка уже выполняется')
  if (state === REQUEST_STATES.verified && !retry) errors.push('заявка уже реализована и проверена')
  if (state === REQUEST_STATES.releasePending || state === REQUEST_STATES.released) errors.push('заявка уже выпускается/выпущена')
  if (state === REQUEST_STATES.cancelled && !retry) errors.push('заявка отменена')
  if (![REQUEST_STATES.approved, REQUEST_STATES.ready, REQUEST_STATES.running, REQUEST_STATES.verified, REQUEST_STATES.failed, REQUEST_STATES.cancelled].includes(state)) {
    errors.push(`состояние ${state} не разрешает реализацию`)
  }
  return { ok: errors.length === 0, state, errors }
}
