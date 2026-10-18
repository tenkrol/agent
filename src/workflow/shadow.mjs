/**
 * 3.4: теневой режим — предложения собираются и оцениваются, но не отправляются.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const writeAtomic = async (file, data) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, file)
}

export function createShadowStore({ file, now = () => Date.now(), logger } = {}) {
  let items = []
  let loaded = false
  const load = async () => {
    if (loaded) return items
    try { items = JSON.parse(await fs.readFile(file, 'utf8')).items ?? [] } catch { items = [] }
    loaded = true
    return items
  }
  const save = () => writeAtomic(file, { version: 1, items }).catch((error) => logger?.warn?.('shadow save failed', { error }))
  return {
    async collect(suggestions = []) {
      await load()
      const added = []
      const ids = new Set(items.map((item) => item.id))
      for (const suggestion of suggestions) {
        if (!suggestion?.id || ids.has(suggestion.id)) continue
        const item = { id: suggestion.id, at: now(), signature: suggestion.id, suggestion, status: 'shadow', history: [{ at: now(), to: 'shadow', reason: 'собрано' }] }
        items.push(item)
        added.push(item)
        ids.add(item.id)
      }
      if (added.length) await save()
      return added
    },
    async decide(id, decision, { outcome, reason } = {}) {
      await load()
      const item = items.find((entry) => entry.id === id)
      if (!item) throw new Error('предложение не найдено')
      if (!['accepted', 'rejected', 'later', 'acted'].includes(decision)) throw new Error('недопустимое решение')
      item.status = decision
      item.outcome = outcome
      item.history.push({ at: now(), to: decision, reason })
      await save()
      return item
    },
    async stats({ since } = {}) {
      await load()
      const rows = items.filter((item) => !since || item.at >= since)
      const by = (status) => rows.filter((item) => item.status === status).length
      return { total: rows.length, shadow: by('shadow'), accepted: by('accepted'), rejected: by('rejected'), later: by('later'), acted: by('acted') }
    },
    async list() { await load(); return items },
  }
}
