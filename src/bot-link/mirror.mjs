/**
 * Зеркалирование ответа агента в чат-бота.
 *
 * Правило домена: если токен точки приёма не настроен — молча пропустить; текст обрезается,
 * ошибка отправки не влияет на ответ владельцу. Сам вызов — в integrations/outbox.
 */
import { postOutbox } from '../integrations/outbox.mjs'

export async function mirrorToAssistant(text, config, { fetchImpl, logger } = {}) {
  const token = config?.outbox?.token
  if (!token) return { ok: false, skipped: 'нет токена' }
  const result = await postOutbox({
    url: config?.outbox?.url,
    token,
    text,
    fetchImpl,
  })
  if (!result.ok && !result.skipped) logger?.debug?.('зеркалирование не удалось', { error: result.error, status: result.status })
  return result
}
