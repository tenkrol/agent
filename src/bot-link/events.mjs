/**
 * Сборка событий контракта v2.
 *
 * Пользовательские события — только `result` и `question`; они создают
 * сообщение в исходном разговоре. Служебное `memory_proposal` не содержит
 * пользовательского текста и отправляется только при поддержке ассистентом.
 *
 * `eventId` постоянный: `<taskId>:<type>:<version>`. Повтор всегда с тем же
 * идентификатором, поэтому получатель может распознать уже обработанное событие.
 */

/** Обрезать текст до предела доставки, сохранив пометку. */
export function truncateDeliveryText(text, maxChars = 3500) {
  const value = String(text ?? '').trim()
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n\n[…текст обрезан]`
}

/** Метаданные файла результата для события. */
export function eventFile(record, caption) {
  return {
    fileId: record.fileId,
    name: record.name,
    size: record.size,
    mime: record.mime,
    ...(caption === undefined ? {} : { caption }),
  }
}

/** Событие результата задачи. */
export function buildResultEvent({ task, text, files = [], version = 1, maxChars = 3500, now = Date.now() } = {}) {
  return {
    contract: 2,
    eventId: `${task.id}:result:${version}`,
    taskId: task.id,
    type: 'result',
    route: task.route,
    createdAt: now,
    attempt: 1,
    text: truncateDeliveryText(text, maxChars),
    title: 'Ответ агента',
    ...(files.length > 0 ? { files } : {}),
  }
}

/** Событие вопроса владельцу. */
export function buildQuestionEvent({ task, text, question, variants = [], version = 1, maxChars = 3500, now = Date.now() } = {}) {
  const payload = {
    contract: 2,
    eventId: `${task.id}:question:${version}`,
    taskId: task.id,
    type: 'question',
    route: task.route,
    createdAt: now,
    attempt: 1,
    text: truncateDeliveryText(text, maxChars),
    title: 'Ответ агента',
  }
  if (String(question ?? '').trim() !== '') {
    payload.question = {
      text: String(question).trim(),
      variants: variants.map((variant) => ({ n: variant.n, text: variant.text })),
    }
  }
  return payload
}

/** Служебное предложение памяти (PLA-17); сообщения пользователю не создаёт. */
export function buildMemoryProposalEvent({ task, proposal, now = Date.now() } = {}) {
  return {
    contract: 2,
    eventId: `${task.id}:memory_proposal:${task.version ?? 1}`,
    taskId: task.id,
    type: 'memory_proposal',
    createdAt: now,
    attempt: 1,
    proposal,
  }
}
