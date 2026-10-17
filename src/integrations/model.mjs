/**
 * Модельный порт для проверки исследования (PLA-15).
 *
 * Сеть — только в integrations. Порту передаётся готовый вопрос, обратно приходит
 * текст; домен verification сам решает, как его разобрать. Ключ не логируется.
 */

export function createModelClient({ baseUrl, apiKey, model, timeoutMs = 90_000, fetchImpl = globalThis.fetch } = {}) {
  return {
    enabled: Boolean(baseUrl && apiKey && model),
    async askModel(prompt, { signal, maxTokens } = {}) {
      if (!apiKey) throw new Error('модельный ключ не настроен')
      const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: String(prompt) }],
          temperature: 0,
          // Вердикт проверки — JSON из трёх критериев с обоснованиями: 300 токенов
          // обрезали его на длинных ответах, и проверка честно уходила в unavailable.
          max_tokens: Number(maxTokens) > 0 ? Number(maxTokens) : 800,
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(`модель ответила ${response.status}`)
      const reported = payload?.usage
      return {
        text: String(payload?.choices?.[0]?.message?.content ?? ''),
        // Нет usage в ответе — это неизвестно, а не ноль: иначе бюджет
        // выглядит израсходованным частично и открывает лишние повторы.
        usage: reported
          ? {
            inputTokens: Number(reported.prompt_tokens) || 0,
            outputTokens: Number(reported.completion_tokens) || 0,
            totalTokens: Number(reported.total_tokens) || 0,
          }
          : { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined, unknown: true },
      }
    },
  }
}
