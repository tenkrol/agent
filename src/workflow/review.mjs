/**
 * 3.3: ручной review — 1–3 подтверждённых предложения без LLM.
 *
 * Каждое предложение объясняет источник, «почему сейчас», пользу, стоимость и
 * способ проверки. Недоступный источник не превращается в «всё хорошо».
 */

const cap = (items, limit) => items.slice(0, Math.max(1, Math.min(3, Number(limit) || 3)))

export function createReviewService({ observe, workItems, now = () => Date.now() } = {}) {
  return {
    async review({ limit = 3 } = {}) {
      const report = await observe?.() ?? { sources: [], findings: [] }
      const suggestions = []
      for (const source of report.sources ?? []) {
        if (source.status === 'unavailable') {
          suggestions.push({
            id: `source-access:${source.id}`,
            title: `Проверить доступ к источнику ${source.id}`,
            sources: [{ id: source.id, evidence: source.error ?? 'unavailable' }],
            whyNow: `источник недоступен с ${new Date(source.checkedAt).toISOString()}`,
            benefit: 'иначе наблюдение пропускает изменения',
            cost: 'минуты, без изменений кода',
            verify: 'повторный observe возвращает status=ok',
          })
        }
      }
      for (const finding of report.findings ?? []) {
        suggestions.push({
          id: `change:${finding.source}:${finding.at}`,
          title: `Разобрать изменение в ${finding.source}`,
          sources: [{ id: finding.source, evidence: finding.evidence }],
          whyNow: `новое доказательство в ${new Date(finding.at).toISOString()}`,
          benefit: 'вовремя заметить незавершённую работу',
          cost: 'один просмотр diff/OpenSpec',
          verify: 'изменение объяснено или создана заявка',
        })
      }
      for (const item of workItems?.list?.({ includeStale: false }) ?? []) {
        suggestions.push({
          id: `work:${item.id}`,
          title: item.title,
          sources: [{ id: item.source?.type ?? 'memory', evidence: item.source?.ref ?? item.id }],
          whyNow: item.status === 'blocked' ? 'дело заблокировано' : 'открытое дело',
          benefit: 'не потерять обязательство/решение',
          cost: 'уточнение статуса',
          verify: 'статус дела обновлён',
        })
      }
      return { at: now(), suggestions: cap(suggestions, limit) }
    },
  }
}
