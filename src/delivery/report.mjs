/**
 * Сборка текста ответа на задачу — чистые правила, без сети и состояния.
 *
 * Домен не импортирует другие домены: ядро передаёт готовые числа (минуты, шаги, токены,
 * стоимость строкой) и флаги, домен решает, как выглядит ответ.
 */

/** Заголовок отчёта по результату задачи. */
export function buildHeader({ result, limits, verification } = {}) {
  if (result?.aborted) return '⛔ Задача отменена.'
  if (result?.stepsExceeded) {
    return `🛑 Остановил задачу: она превысила ${limits.taskMaxSteps} шагов. `
      + 'Похоже, агент ушёл исследовать вместо того, чтобы сделать; задачу стоит сузить.'
  }
  if (result?.budgetExceeded) {
    return `🛑 Остановил задачу: расход превысил ${limits.taskTokenBudget.toLocaleString('ru-RU')} токенов. `
      + 'Обычно это значит, что агент зациклился; задачу лучше переформулировать или разбить.'
  }
  if (verification && ['partial', 'failed', 'unavailable'].includes(verification.status) && result?.ok) {
    return '⚠️ Выполнено частично: не все проверки результата пройдены.'
  }
  if (result?.timedOut) {
    return `⌛ Превышен лимит времени (${Math.round(limits.taskTimeoutMs / 60000)} мин), выполнение остановлено.`
  }
  if (!result?.ok) return `⚠️ Задача завершилась с кодом ${result?.exitCode ?? '—'}.`
  return ''
}

/** Тело ответа: текст задачи с обрезкой и пометкой. */
export function buildBody({ result, maxAnswerChars } = {}) {
  const answer = String(result?.text ?? '').trim()
  if (answer === '') return result?.aborted ? '' : 'Агент не вернул текст ответа.'
  if (answer.length <= maxAnswerChars) return answer
  return `${answer.slice(0, maxAnswerChars)}\n\n[…ответ обрезан]`
}

/** Диагностика stderr для неудачной задачи. */
export function buildDiagnostics({ result, errorTailChars = 1200 } = {}) {
  if (!result || result.ok || result.aborted || !result.stderr) return ''
  return `\n_Диагностика:_\n\`\`\`\n${String(result.stderr).slice(-errorTailChars)}\n\`\`\``
}

/** Подпись под ответом: время, шаги, токены, стоимость. */
export function buildFooter({ minutes, steps, tokens, usdText } = {}) {
  return `\n_${minutes} мин, шагов ${steps}, токенов ${Number(tokens).toLocaleString('ru-RU')}, ≈${usdText}._`
}

/** Отдельная строка про дорогую задачу. */
export function buildExpensiveNote({ tokens, steps, usdText, warnAt } = {}) {
  if (!(warnAt > 0) || !(tokens > warnAt)) return ''
  return `💰 Дорогая задача: ${Number(tokens).toLocaleString('ru-RU')} токенов за ${steps} шаг(ов), ≈${usdText}.`
}

/** Заметки brief-режима: проблемы вложений и пути архива. */
export function buildBriefNotes({ reportStyle, issue, taskId, diskPaths = [] } = {}) {
  if (reportStyle !== 'brief') return []
  const notes = []
  if (issue) notes.push(issue)
  if (diskPaths.length > 0) notes.push(`📁 Файлы задачи ${taskId} лежат на Яндекс.Диске: ${diskPaths.join(', ')}`)
  return notes
}

/** Строка о проверке результата: что проверено, а что нет. */
export function buildVerificationNote({ verification } = {}) {
  if (!verification) return ''
  const status = verification.status
  if (status === 'disabled') return 'Проверка отключена (VERIFY=false): результат не проверялся.'
  if (status === 'not_required') return 'Проверка не требуется для этого результата.'
  const lines = []
  const passed = (verification.criteria ?? []).filter((item) => item.status === 'passed').map((item) => item.id)
  const failed = (verification.criteria ?? []).filter((item) => item.status === 'failed')
  const unavailable = (verification.criteria ?? []).filter((item) => item.status === 'unavailable')
  if (status === 'passed') lines.push(`Проверка: пройдена${passed.length ? ` (${passed.join(', ')})` : ''}.`)
  else if (status === 'failed') lines.push('Проверка: не пройдена.')
  else if (status === 'unavailable') lines.push('Проверка недоступна: результат не проверен.')
  else lines.push('Проверка: частично.')
  if (failed.length > 0) lines.push(`Не прошло: ${failed.map((item) => `${item.id} — ${item.evidence || item.notes || 'без деталей'}`).join('; ')}`)
  if (unavailable.length > 0) lines.push(`Не проверено: ${unavailable.map((item) => `${item.id}${item.notes ? ` (${item.notes})` : ''}`).join('; ')}`)
  if (Array.isArray(verification.limitations) && verification.limitations.length > 0 && status !== 'passed') {
    lines.push(`Ограничения проверки: ${verification.limitations.slice(0, 5).join('; ')}`)
  }
  return lines.join('\n')
}

/**
 * Полный текст ответа.
 *
 * @param {object} request - данные отчёта.
 * @returns {string} текст для чата.
 */
export function composeReportText(request = {}) {
  const { result, job, limits, reportStyle, maxAnswerChars, errorTailChars, diskPaths = [], footer, usdText, verification } = request
  const header = buildHeader({ result, limits, verification })
  const parts = [header, buildBody({ result, maxAnswerChars }), buildDiagnostics({ result, errorTailChars })]
  const verificationNote = buildVerificationNote({ verification })
  if (verificationNote !== '') parts.push(verificationNote)
  if (footer) parts.push(buildFooter(footer))
  // Предупреждение о дорогой задаче не показываем для отменённой задачи — как и раньше.
  if (!result?.aborted) {
    parts.push(buildExpensiveNote({
      tokens: result?.usage?.totalTokens,
      steps: result?.usage?.steps,
      usdText,
      warnAt: limits?.taskTokenWarn,
    }))
  }
  parts.push(...buildBriefNotes({ reportStyle, issue: job?.issue, taskId: job?.id, diskPaths }))
  return parts.filter((part) => part !== '').join('\n\n')
}

/** Строка статуса задачи (её правят в сообщении-якоре). */
export function statusMarkdown({ result, taskId, header, limits } = {}) {
  if (result?.aborted || result?.timedOut) return header ?? buildHeader({ result, limits })
  return `✅ Задача ${taskId} выполнена.`
}

/** Подпись быстрого ответа (без запуска задачи). */
export function quickFooter({ tokens, usdText, taskId } = {}) {
  return `\n_⚡ ответил сразу, без запуска задачи: ${Number(tokens).toLocaleString('ru-RU')} токенов, ≈${usdText}. Нужна полноценная работа — /retry ${taskId}._`
}

/** Строка статуса быстрого ответа. */
export function quickStatus({ taskId } = {}) {
  return `✅ Ответил сразу (${taskId}).`
}
