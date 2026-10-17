/**
 * Жизненный цикл задачи (этап 1, PLA-19).
 *
 * Внутренние стадии отделены от публичных статусов журнала: смена внутренней
 * модели не должна переименовывать то, что видит бот и владелец. Переходы
 * описаны таблицей, а не разбросаны по вызывающему коду.
 */
export const STAGE = {
  queued: 'queued',
  executing: 'executing',
  awaitingOwner: 'awaiting_owner',
  verifying: 'verifying',
  repairing: 'repairing',
  done: 'done',
  partial: 'partial',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
}

/** Разрешённые переходы между стадиями одной попытки. */
const TRANSITIONS = {
  queued: new Set(['executing', 'cancelled', 'interrupted', 'failed']),
  executing: new Set(['verifying', 'awaiting_owner', 'partial', 'failed', 'cancelled', 'interrupted']),
  verifying: new Set(['repairing', 'done', 'partial', 'failed', 'cancelled', 'interrupted']),
  repairing: new Set(['verifying', 'partial', 'failed', 'cancelled', 'interrupted']),
  awaiting_owner: new Set(['executing', 'cancelled', 'interrupted']),
  done: new Set(),
  partial: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
}

/** Проверить переход; неизвестный переход — ошибка программиста. */
export function assertTransition(from, to) {
  if (from === to) return
  if (!TRANSITIONS[from]?.has(to)) throw new Error(`недопустимый переход задачи: ${from} → ${to}`)
}

/**
 * Итоговый публичный статус по результату исполнения и проверки.
 *
 * Отмена и лимит никогда не становятся `done`; частичный результат с
 * недоступной/неудачной проверкой — `partial`.
 */
export function classifyOutcome({ result = {}, verification, stopping = false } = {}) {
  const aborted = Boolean(result.aborted)
  if (stopping && aborted) return { status: STAGE.interrupted, reason: 'перезапуск сервиса' }
  if (aborted) return { status: STAGE.cancelled, reason: 'cancelled' }
  if (result.timedOut) return { status: STAGE.failed, reason: 'timeout' }
  if (result.budgetExceeded) return { status: STAGE.failed, reason: 'budget' }
  if (result.stepsExceeded) return { status: STAGE.failed, reason: 'steps' }
  if (!result.ok) return { status: STAGE.failed, reason: 'exit' }
  const verificationFailed = verification && ['partial', 'failed', 'unavailable'].includes(verification.status)
  return { status: verificationFailed ? STAGE.partial : STAGE.done, reason: undefined }
}
