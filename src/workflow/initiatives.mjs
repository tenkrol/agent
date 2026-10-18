/**
 * 3.5: инициативы — лимит, дедупликация, тихие часы, решения.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const atomic = async (file, data) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, file)
}

const dayKey = (date, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
const hourOf = (date, timeZone) => Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(date))

export function inQuietHours(date, { from, to, timeZone = 'UTC' } = {}) {
  if (from === undefined || to === undefined) return false
  const hour = hourOf(date, timeZone)
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to
}

export function createInitiativeService({ file, dailyLimit = 3, quietHours, timeZone = 'UTC', now = () => Date.now(), logger } = {}) {
  let items = []
  let loaded = false
  const load = async () => {
    if (loaded) return items
    try { items = JSON.parse(await fs.readFile(file, 'utf8')).items ?? [] } catch { items = [] }
    loaded = true
    return items
  }
  const save = () => atomic(file, { version: 1, items }).catch((error) => logger?.warn?.('initiative save failed', { error }))

  return {
    async propose(suggestions = []) {
      await load()
      const date = new Date(now())
      if (inQuietHours(date, { ...(quietHours ?? {}), timeZone })) return []
      const day = dayKey(date, timeZone)
      const today = items.filter((item) => item.day === day && ['proposed', 'later', 'done'].includes(item.status))
      let remaining = Math.max(0, dailyLimit - today.length)
      const chosen = []
      for (const suggestion of suggestions) {
        if (remaining <= 0) break
        const signature = String(suggestion.signature ?? suggestion.id ?? '')
        if (!signature) continue
        if (items.some((item) => item.signature === signature && item.status === 'never')) continue
        if (items.some((item) => item.signature === signature && item.day === day && item.status === 'proposed')) continue
        const item = { id: suggestion.id ?? signature, signature, at: now(), day, status: 'proposed', suggestion }
        items.push(item)
        chosen.push(item)
        remaining -= 1
      }
      if (chosen.length) await save()
      return chosen
    },
    async decide(id, decision, { reason } = {}) {
      await load()
      if (!['done', 'later', 'never'].includes(decision)) throw new Error('решение: done|later|never')
      const item = items.find((entry) => entry.id === id)
      if (!item) throw new Error('инициатива не найдена')
      item.status = decision
      item.history = [...(item.history ?? []), { at: now(), to: decision, reason }]
      await save()
      return item
    },
    async list() { await load(); return items },
  }
}
