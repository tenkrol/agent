/**
 * Отправка сообщения владельцу напрямую через Bot API.
 *
 * Алерты шлёт таймер, а не процесс бота: если сервис агента лежит, предупредить
 * об этом всё равно нужно. Поэтому здесь минимальная отправка без зависимостей
 * от платформенного слоя — только токен и чат владельца.
 */

/** Отправить текст в Telegram. Никогда не бросает: возвращает результат. */
export async function sendTelegram({ token, chatId, text, timeoutMs = 20_000, fetchImpl = globalThis.fetch } = {}) {
  if (!token || chatId === undefined || chatId === null || chatId === '') {
    return { ok: false, error: 'не заданы токен или чат владельца' }
  }
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Без parse_mode: текст алертов не должен ломаться о разметку.
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload?.ok === false) {
      return { ok: false, error: `Telegram ответил ${response.status}: ${String(payload?.description ?? '').slice(0, 160)}` }
    }
    return { ok: true, messageId: payload?.result?.message_id }
  } catch (error) {
    return { ok: false, error: `Telegram недоступен: ${String(error?.message ?? error).slice(0, 160)}` }
  }
}
