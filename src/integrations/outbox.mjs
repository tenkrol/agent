/**
 * Точка приёма чат-бота: HTTPS-вызов, через который агент зеркалирует ответ.
 *
 * Единственное место с `fetch` для зеркалирования: правило «когда и что зеркалировать»
 * живёт в домене bot-link, транспорт — здесь.
 */

/** Отправить текст в точку приёма; ошибки не бросаются — молчание лучше падения. */
export async function postOutbox({ url, token, text, title = 'Ответ агента', timeoutMs = 15_000, fetchImpl = globalThis.fetch } = {}) {
  if (!token) return { ok: false, skipped: 'нет токена точки приёма' }
  const body = String(text ?? '').trim()
  if (body === '') return { ok: false, skipped: 'пустой текст' }
  try {
    const response = await fetchImpl(url || 'http://127.0.0.1:8788/outbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: body.slice(0, 3500), title }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { ok: Boolean(response?.ok), status: response?.status }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}
