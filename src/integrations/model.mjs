/**
 * Модельный порт для проверки исследования (PLA-15).
 *
 * Сеть — только в integrations. Порту передаётся готовый вопрос, обратно приходит
 * текст; домен verification сам решает, как его разобрать. Ключ не логируется.
 */

export function createModelClient({ baseUrl, apiKey, model, timeoutMs = 90_000, fetchImpl = globalThis.fetch } = {}) {
  return {
    enabled: Boolean(baseUrl && apiKey && model),
    async askModel(prompt, { signal } = {}) {
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
          max_tokens: 800,
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(`модель ответила ${response.status}`)
      return {
        text: String(payload?.choices?.[0]?.message?.content ?? ''),
        usage: {
          inputTokens: Number(payload?.usage?.prompt_tokens) || 0,
          outputTokens: Number(payload?.usage?.completion_tokens) || 0,
          totalTokens: Number(payload?.usage?.total_tokens) || 0,
        },
      }
    },
  }
}
