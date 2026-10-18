/**
 * 3.6: политика действий. LLM может предложить действие, но не расширить разрешения.
 */
const MODES = new Set(['observe', 'prepare', 'execute', 'approval'])

export function createActionPolicy({ mode = 'observe', enabled = true, allowlist = [], budget = { limit: 0, spent: 0 }, approvalRequired = true } = {}) {
  let current = MODES.has(mode) ? mode : 'observe'
  let active = Boolean(enabled)
  let spent = Number(budget.spent) || 0
  const limit = Number(budget.limit) || 0
  return {
    status: () => ({ mode: current, enabled: active, budget: { limit, spent } }),
    setMode(next) { if (!MODES.has(next)) throw new Error('режим: observe|prepare|execute|approval'); current = next; return current },
    setEnabled(value) { active = Boolean(value); return active },
    cancel() { active = false; current = 'observe' },
    decide({ action, cost = 0, needsApproval } = {}) {
      if (!active) return { allowed: false, requiresApproval: false, reason: 'действия выключены' }
      if (!String(action ?? '').trim()) return { allowed: false, requiresApproval: false, reason: 'действие не задано' }
      if (current === 'observe') return { allowed: false, requiresApproval: false, reason: 'режим наблюдения' }
      if (current === 'prepare') {
        if (!String(action).startsWith('prepare:')) return { allowed: false, requiresApproval: false, reason: 'разрешена только подготовка' }
        return { allowed: true, requiresApproval: false, reason: 'подготовка разрешена' }
      }
      if (current === 'approval') return { allowed: false, requiresApproval: true, reason: 'нужно подтверждение владельца' }
      if (current === 'execute') {
        if (allowlist.length > 0 && !allowlist.includes(action)) return { allowed: false, requiresApproval: false, reason: 'действие не в allowlist' }
        if (limit > 0 && spent + Number(cost) > limit) return { allowed: false, requiresApproval: false, reason: 'бюджет действий исчерпан' }
        if (needsApproval ?? approvalRequired) return { allowed: false, requiresApproval: true, reason: 'нужно подтверждение владельца' }
        spent += Number(cost) || 0
        return { allowed: true, requiresApproval: false, reason: 'разрешено' }
      }
      return { allowed: false, requiresApproval: false, reason: 'неизвестный режим' }
    },
  }
}
