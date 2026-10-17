/**
 * Разбор и валидация запросов контракта v2.
 *
 * Ошибка разбора — это HTTP-ответ с кодом, а не исключение внутри ядра:
 * `ProtocolError` несёт статус и читаемый текст, чтобы мост ответил `400`/`409`.
 */

export class ProtocolError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'ProtocolError'
    this.status = status
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const text = (value, max, name) => {
  const result = String(value ?? '').trim()
  if (result === '') throw new ProtocolError(400, `${name} обязателен`)
  if (result.length > max) throw new ProtocolError(400, `${name} длиннее ${max} символов`)
  return result
}

const requestIdOf = (payload) => text(payload?.requestId, 200, 'requestId')

/** Проверить и нормализовать маршрут ответа. */
export function parseRoute(route, { routeConfig = {} } = {}) {
  if (route === undefined || route === null) return undefined
  if (!isObject(route)) throw new ProtocolError(400, 'route должен быть объектом')
  const platform = String(route.platform ?? 'telegram').trim()
  if (platform !== 'telegram') throw new ProtocolError(400, 'route.platform поддерживает только telegram')
  const chatId = String(route.chatId ?? '').trim()
  if (chatId === '') throw new ProtocolError(400, 'route.chatId обязателен')
  const botId = route.botId === undefined ? undefined : String(route.botId).trim()
  if (routeConfig.botId && botId !== String(routeConfig.botId)) {
    throw new ProtocolError(400, 'route.botId не от настроенного ассистента')
  }
  if (routeConfig.chatId && chatId !== String(routeConfig.chatId)) {
    throw new ProtocolError(400, 'route.chatId не от настроенного ассистента')
  }
  return {
    platform,
    botId,
    chatId,
    threadId: route.threadId === undefined || route.threadId === null ? undefined : String(route.threadId),
    messageId: Number.isFinite(Number(route.messageId)) ? Number(route.messageId) : undefined,
  }
}

/** Проверить `context.facts`: массив объектов, а не строк. */
export function parseFacts(facts) {
  if (facts === undefined || facts === null) return []
  if (!Array.isArray(facts)) throw new ProtocolError(400, 'context.facts должен быть массивом')
  if (facts.length > 50) throw new ProtocolError(400, 'context.facts: больше 50 фактов')
  return facts.map((fact) => {
    if (!isObject(fact)) throw new ProtocolError(400, 'context.facts: ожидался объект {text,…}')
    const value = text(fact.text, 300, 'context.facts[].text')
    const subject = fact.subject === undefined || fact.subject === null ? undefined : String(fact.subject).trim().slice(0, 60)
    const validUntil = fact.validUntil === undefined || fact.validUntil === null ? undefined : Number(fact.validUntil)
    if (validUntil !== undefined && !Number.isFinite(validUntil)) {
      throw new ProtocolError(400, 'context.facts[].validUntil: ожидалось число (мс)')
    }
    return { text: value, ...(subject ? { subject } : {}), ...(validUntil ? { validUntil } : {}) }
  })
}

/** Вложения задачи: только `fileId` из реестра, без произвольных путей и URL. */
export function parseAttachments(attachments, { maxFiles = 20, fileExists } = {}) {
  if (attachments === undefined || attachments === null) return []
  if (!Array.isArray(attachments)) throw new ProtocolError(400, 'attachments должен быть массивом')
  if (attachments.length > maxFiles) throw new ProtocolError(400, `attachments: больше ${maxFiles} файлов`)
  return attachments.map((item) => {
    if (!isObject(item)) throw new ProtocolError(400, 'attachments[]: ожидался объект')
    const fileId = String(item.fileId ?? '').trim()
    if (!/^f_[A-Za-z0-9]+$/.test(fileId)) throw new ProtocolError(400, 'attachments[].fileId недопустим')
    if (fileExists && !fileExists(fileId)) throw new ProtocolError(400, `неизвестный fileId ${fileId}`)
    return {
      fileId,
      kind: String(item.kind ?? 'document').slice(0, 20),
      name: item.name === undefined ? undefined : String(item.name).slice(0, 120),
      mime: item.mime === undefined ? undefined : String(item.mime).slice(0, 160),
      size: Number.isFinite(Number(item.size)) ? Number(item.size) : undefined,
    }
  })
}

/**
 * Разобрать постановку задачи.
 *
 * @param {object} payload - тело запроса.
 * @param {object} options - `maxTaskChars`, `routeConfig`, `fileExists`.
 * @returns {object} нормализованный запрос.
 */
export function parseTaskRequest(payload, { maxTaskChars = 4000, routeConfig = {}, fileExists } = {}) {
  if (!isObject(payload)) throw new ProtocolError(400, 'тело запроса должно быть объектом')
  if (Number(payload.contract ?? 0) !== 2) throw new ProtocolError(400, 'contract должен быть 2')
  const requestId = requestIdOf(payload)
  const task = text(payload.task, maxTaskChars, 'task')
  return {
    contract: 2,
    requestId,
    task,
    source: String(payload.source ?? 'assistant').slice(0, 40),
    revisionOf: payload.revisionOf === undefined || payload.revisionOf === null ? undefined : String(payload.revisionOf).trim(),
    route: parseRoute(payload.route, { routeConfig }),
    attachments: parseAttachments(payload.attachments, { fileExists }),
    facts: parseFacts(payload.context?.facts),
  }
}

/** Разобрать ответ на вопрос. */
export function parseReplyRequest(payload) {
  if (!isObject(payload)) throw new ProtocolError(400, 'тело запроса должно быть объектом')
  if (Number(payload.contract ?? 0) !== 2) throw new ProtocolError(400, 'contract должен быть 2')
  const requestId = requestIdOf(payload)
  const value = String(payload.text ?? '').trim()
  if (value === '') throw new ProtocolError(400, 'text обязателен')
  const variant = Number.isFinite(Number(payload.variant)) ? Number(payload.variant) : undefined
  return { requestId, text: value, variant }
}

/** Разобрать отмену. */
export function parseCancelRequest(payload) {
  if (!isObject(payload)) throw new ProtocolError(400, 'тело запроса должно быть объектом')
  if (Number(payload.contract ?? 0) !== 2) throw new ProtocolError(400, 'contract должен быть 2')
  return { requestId: requestIdOf(payload) }
}

/** `fileId` из пути `/v1/files/:id`. */
export function parseFileId(pathname) {
  const match = String(pathname ?? '').match(/^\/v1\/files\/(f_[A-Za-z0-9]+)$/)
  return match ? match[1] : undefined
}
