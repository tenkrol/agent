/**
 * Точка приёма чат-бота: HTTPS-вызовы, через которые агент доставляет результат.
 *
 * Единственное место с `fetch` для исходящей доставки: правило «когда и что
 * доставлять» живёт в домене bot-link, транспорт — здесь. Два режима:
 * прежний текстовый `/outbox` (совместимость) и событие контракта v2 с `eventId`
 * и подтверждением обработки.
 */

/** Отправить текст в точку приёма по-старому; ошибки не бросаются. */
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

/**
 * Отправить событие контракта v2 (результат, вопрос, предложение памяти).
 *
 * Возвращает разобранный ответ: `processed: true` — получатель подтвердил
 * обработку (`ack`); `processed: false` при 2xx — совместимость со старым
 * приёмником, который принимает текст, но не умеет подтверждать. Ошибки не
 * бросаются: решение о повторе принимает воркер доставки.
 */
export async function postAgentEvent({ url, token, event, timeoutMs = 20_000, fetchImpl = globalThis.fetch } = {}) {
  if (!token) return { ok: false, skipped: 'нет токена точки приёма' }
  if (!event || typeof event.eventId !== 'string') return { ok: false, error: 'нет eventId' }
  try {
    const response = await fetchImpl(url || 'http://127.0.0.1:8788/outbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const payload = await response.json().catch(() => ({}))
    return {
      ok: Boolean(response?.ok),
      status: response?.status,
      processed: payload?.processed === true,
      duplicate: payload?.duplicate === true,
      eventId: payload?.eventId,
      error: response?.ok ? undefined : String(payload?.error ?? `HTTP ${response?.status}`).slice(0, 200),
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}
