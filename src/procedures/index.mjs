/**
 * Домен procedures: личные повторяемые поручения с неизменяемыми версиями.
 *
 * Процедура — это назначение, шаблон задачи, параметры, формат результата,
 * критерии проверки и ограничения. Версия создаётся `active`, только если все
 * обязательные поля известны; иначе — `draft`, пока владелец не заполнит поля и
 * явно не активирует версию. Активная/архивная версии неизменяемы.
 */
const REQUIRED = ['purpose', 'taskTemplate', 'resultFormat', 'criteria', 'limits']

const missingFields = (version) => REQUIRED.filter((field) => {
  if (field === 'criteria') return !Array.isArray(version.criteria) || version.criteria.length === 0
  if (field === 'limits') return version.limits === undefined || version.limits === null
  return String(version[field] ?? '').trim() === ''
})

const clone = (value) => JSON.parse(JSON.stringify(value))

export function createProcedures({ store, globalLimits = {}, now = () => new Date() } = {}) {
  const activeVersionOf = (record) => (record?.versions ?? []).find((version) => version.version === record.activeVersion)

  /** Лимиты процедуры не могут превышать глобальные. */
  const checkLimits = (limits = {}) => {
    const pairs = [
      ['taskTokenBudget', 'tokenBudget', 'TASK_TOKEN_BUDGET'],
      ['taskMaxSteps', 'maxSteps', 'TASK_MAX_STEPS'],
      ['taskTimeoutMs', 'timeoutMs', 'TASK_TIMEOUT_MS'],
    ]
    for (const [key, globalKey, envName] of pairs) {
      const value = Number(limits?.[key])
      const global = Number(globalLimits?.[globalKey] ?? 0)
      if (!Number.isFinite(value) || value <= 0) continue
      if (global > 0 && value > global) throw new Error(`${key} выше глобального предела ${envName} (${global})`)
    }
    return limits
  }

  /** Что удалось вывести из задачи, а что нет. */
  const deriveFromTask = (record, criteria = []) => {
    const request = String(record?.request ?? record?.text ?? '').trim()
    const files = Array.isArray(record?.files) ? record.files : []
    const ext = files.map((file) => String(file).split('.').pop().toLowerCase())
    const resultFormat = ext.includes('docx') ? 'DOCX'
      : ext.includes('xlsx') ? 'XLSX'
        : ext.includes('pptx') ? 'PPTX'
          : ext.includes('pdf') ? 'PDF'
            : ext.includes('csv') ? 'CSV' : ''
    const version = {
      version: 1,
      status: 'draft',
      purpose: String(record?.brief ?? '').trim(),
      taskTemplate: request,
      params: [],
      resultFormat,
      criteria: clone(criteria),
      limits: {},
      createdAt: now().getTime(),
      createdBy: 'owner',
      sourceTaskId: record?.id,
    }
    const missing = missingFields(version)
    if (missing.length === 0) {
      version.status = 'active'
      version.activatedAt = now().getTime()
    }
    return { version, missing }
  }

  const saveFromTask = async ({ name, record, criteria = [] }) => {
    const clean = String(name ?? '').trim()
    if (!clean) throw new Error('имя процедуры обязательно')
    const { version, missing } = deriveFromTask(record, criteria)
    const existing = store.get(clean)
    if (existing) throw new Error(`процедура «${clean}» уже есть`)
    const procedure = await store.create({
      name: clean,
      versions: [version],
      activeVersion: version.status === 'active' ? version.version : null,
    })
    return { procedure, version, missing }
  }

  const editFromTask = async ({ name, record, criteria = [] }) => {
    const existing = store.get(name)
    if (!existing) throw new Error(`процедура «${name}» не найдена`)
    const { version } = deriveFromTask(record, criteria)
    version.version = Math.max(0, ...existing.versions.map((item) => item.version)) + 1
    version.status = 'draft'
    existing.versions.push(version)
    await store.update(existing.id, { versions: existing.versions })
    return { procedure: existing, version, missing: missingFields(version) }
  }

  const draftOf = (record) => (record.versions ?? []).find((version) => version.status === 'draft')

  const setField = async (name, field, value) => {
    const record = store.get(name)
    if (!record) throw new Error(`процедура «${name}» не найдена`)
    if (!['purpose', 'taskTemplate', 'resultFormat', 'limits', 'criteria', 'params'].includes(field)) {
      throw new Error(`поле «${field}» не поддерживается`)
    }
    let draft = draftOf(record)
    if (!draft) {
      const active = activeVersionOf(record)
      if (!active) throw new Error('у процедуры нет активной версии')
      if (active.status === 'active') active.status = 'archived'
      draft = { ...clone(active), version: Math.max(...record.versions.map((version) => version.version)) + 1, status: 'draft', createdAt: now().getTime() }
      record.versions.push(draft)
    }
    let parsed = value
    if (field === 'limits') parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (field === 'criteria') parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (field === 'params') parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (field === 'limits') checkLimits(parsed)
    draft[field] = parsed
    await store.update(record.id, { versions: record.versions, activeVersion: record.activeVersion })
    return { procedure: record, version: draft, missing: missingFields(draft) }
  }

  const activate = async (name) => {
    const record = store.get(name)
    if (!record) throw new Error(`процедура «${name}» не найдена`)
    const draft = draftOf(record)
    if (!draft) throw new Error('у процедуры нет черновика для активации')
    const missing = missingFields(draft)
    if (missing.length > 0) throw new Error(`не хватает полей: ${missing.join(', ')}`)
    for (const version of record.versions) if (version.status === 'active') version.status = 'archived'
    draft.status = 'active'
    draft.activatedAt = now().getTime()
    await store.update(record.id, { versions: record.versions, activeVersion: draft.version })
    return { procedure: record, version: draft }
  }

  /** Собрать текст задачи из активной версии и параметров. */
  const render = ({ name, params = {} } = {}) => {
    const record = store.get(name)
    if (!record) return { ok: false, error: `процедура «${name}» не найдена` }
    const version = activeVersionOf(record)
    if (!version || version.status !== 'active') {
      const draft = draftOf(record)
      const missing = draft ? missingFields(draft) : REQUIRED
      return { ok: false, error: `процедура не активирована; не хватает: ${missing.join(', ') || 'активации'}` }
    }
    const missingParams = (version.params ?? [])
      .filter((param) => param.required && params[param.name] === undefined && param.default === undefined)
      .map((param) => param.name)
    if (missingParams.length > 0) return { ok: false, error: `не хватает параметров: ${missingParams.join(', ')}` }
    const values = {}
    for (const param of version.params ?? []) values[param.name] = params[param.name] ?? param.default ?? ''
    const filled = String(version.taskTemplate).replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, key) => String(values[key] ?? ''))
    const parts = [filled]
    if (version.resultFormat) parts.push(`Формат результата: ${version.resultFormat}`)
    if (version.criteria?.length) parts.push(`Критерии проверки:\n${version.criteria.map((criterion) => `- ${criterion.text}`).join('\n')}`)
    return { ok: true, text: parts.join('\n\n'), version: version.version, procedure: { id: record.id, name: record.name } }
  }

  return {
    list: () => store.all(),
    get: (name) => store.get(name),
    activeVersion: (name) => activeVersionOf(store.get(name)),
    saveFromTask,
    editFromTask,
    setField,
    activate,
    remove: (name) => store.remove(store.get(name)?.id),
    render,
    missingFields,
    derive: deriveFromTask,
  }
}
