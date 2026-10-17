/**
 * Домен verification: проверка результата по критериям.
 *
 * Домен не запускает процессы и не ходит в сеть сам — ядро передаёт готовые порты.
 * Каждый файловый порт получает `root` (рабочую папку задачи) и сам проверяет, что
 * путь не выходит за её пределы.
 */
import { deriveCriteria, detectResultKind, isVerificationNeeded } from './criteria.mjs'

export { deriveCriteria, detectResultKind, isVerificationNeeded, sectionsFrom } from './criteria.mjs'

const STATUS = {
  passed: 'passed',
  failed: 'failed',
  partial: 'partial',
  unavailable: 'unavailable',
  notRequired: 'not_required',
  disabled: 'disabled',
}

const criterionResult = (criterion, status, evidence, notes) => ({
  id: criterion.id,
  status,
  evidence: evidence === undefined ? '' : String(evidence).slice(0, 500),
  ...(notes ? { notes: String(notes).slice(0, 500) } : {}),
})

const extensionOf = (name) => String(name ?? '').split('.').pop().toLowerCase()

/** Найти первый разбираемый JSON-объект в ответе модели (без хрупких регулярок). */
function firstJsonObject(text) {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index++) {
      const char = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') { inString = true; continue }
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, index + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return undefined
}

/** Разобрать структурированный вердикт проверки исследования. */
function parseResearchVerdict(raw) {
  const text = String(raw ?? '').trim().replace(/^\x60\x60\x60(?:json)?/i, '').replace(/\x60\x60\x60$/i, '').trim()
  const parsed = firstJsonObject(text)
  if (!parsed || typeof parsed !== 'object') return { error: 'вердикт не разобран как JSON' }
  const allowed = new Set(['passed', 'failed', 'unavailable'])
  const verdict = {}
  for (const key of ['sources', 'linkage', 'assumptions']) {
    const item = parsed?.[key]
    if (!item || typeof item !== 'object') return { error: 'в вердикте нет критерия ' + key }
    if (!allowed.has(item.status)) return { error: 'неизвестный статус критерия ' + key }
    if (typeof item.reason !== 'string' || item.reason.trim() === '') return { error: 'нет обоснования критерия ' + key }
    verdict[key] = { status: item.status, reason: item.reason.trim() }
  }
  return { verdict }
}

/** Собрать свидетельство по таблицам: все файлы, пересчёт каждого. */
async function verifySpreadsheets({ files, root, ports, timeoutMs, limitations, signal }) {
  const inspected = []
  for (const file of files) {
    try {
      const value = await ports.inspectSpreadsheet({ root, path: file.relPath, name: file.name, signal })
      inspected.push({ file, opens: value?.opens === true, text: String(value?.text ?? ''), initialErrors: Array.isArray(value?.errors) ? value.errors : [] })
    } catch (error) {
      inspected.push({ file, opens: false, text: '', initialErrors: [], inspectError: String(error?.message ?? error) })
    }
  }
  for (const entry of inspected) {
    if (!ports.recalcSpreadsheet) {
      entry.recalcError = 'порт пересчёта недоступен'
      continue
    }
    try {
      entry.recalc = await ports.recalcSpreadsheet({ root, path: entry.file.relPath, timeoutMs, signal })
    } catch (error) {
      entry.recalcError = String(error?.message ?? error)
    }
  }
  return inspected
}


/**
 * Проверить результат.
 *
 * @param {object} input - `taskText`, `files` (метаданные с `name`/`relPath`),
 *   `answer`, `root`, `ports`, `allowlist`, `timeoutMs`, `now`.
 * @returns {Promise<object>} результат проверки.
 */
export async function verify({ taskText = '', files = [], answer = '', root, ports = {}, allowlist = [], timeoutMs = 300_000, signal, budget, now = () => Date.now() } = {}) {
  const { kind, criteria } = deriveCriteria({ taskText, files })
  const limitations = []
  const results = []
  /** @type {object|undefined} расход проверяющей модели для общего бюджета. */
  let verificationUsage

  if (criteria.length === 0) {
    return { status: STATUS.notRequired, criteria: [], limitations: [], checkedAt: now(), kind }
  }

  const aborted = () => Boolean(signal?.aborted)
  const cancelled = () => ({
    status: 'unavailable',
    criteria: criteria.map((criterion) => criterionResult(criterion, 'unavailable', '', 'проверка отменена')),
    limitations: ['проверка отменена'],
    checkedAt: now(),
    kind,
    aborted: true,
  })
  if (aborted()) return cancelled()
  const byExtension = (set) => files.filter((file) => set.has(extensionOf(file.name ?? file.relPath)))

  if (kind === 'document') {
    const docs = byExtension(new Set(['docx', 'docm', 'odt', 'pdf', 'doc']))
    if (!ports.inspectDocument) {
      limitations.push('порт проверки документа недоступен')
      for (const criterion of criteria) results.push(criterionResult(criterion, 'unavailable', '', 'порт недоступен'))
    } else {
      const inspected = []
      for (const file of docs) {
        try {
          inspected.push({ file, ...(await ports.inspectDocument({ root, path: file.relPath, name: file.name, signal })) })
        } catch (error) {
          inspected.push({ file, opens: false, text: '', error: String(error?.message ?? error) })
        }
      }
      if (aborted()) return cancelled()
      if (inspected.length === 0) {
        for (const criterion of criteria) results.push(criterionResult(criterion, 'unavailable', '', 'нет документа для проверки'))
        limitations.push('документ не создан')
      }
      const allOpen = inspected.length > 0 && inspected.every((file) => file.opens === true)
      const text = inspected.map((file) => file.text ?? '').join('\n').toLowerCase()
      for (const criterion of criteria) {
        if (criterion.id === 'opens') {
          results.push(criterionResult(criterion, allOpen ? 'passed' : 'failed', allOpen ? 'файлы открываются' : 'файл не открылся'))
        } else if (criterion.id === 'sections') {
          const missing = (criterion.sections ?? []).filter((section) => !text.includes(String(section).toLowerCase()))
          results.push(criterionResult(criterion, missing.length === 0 ? 'passed' : 'failed',
            missing.length === 0 ? 'все разделы найдены' : `нет разделов: ${missing.join(', ')}`))
        } else if (criterion.id === 'render') {
          if (!ports.renderDocument) {
            results.push(criterionResult(criterion, 'unavailable', '', 'рендер недоступен'))
            limitations.push('проверка оформления недоступна')
          } else {
            try {
              const rendered = await ports.renderDocument({ root, path: docs[0]?.relPath, to: 'pdf', signal })
              results.push(criterionResult(criterion, rendered?.ok ? 'passed' : 'unavailable', rendered?.path ?? '', rendered?.error ?? ''))
              if (!rendered?.ok) limitations.push(`рендер: ${rendered?.error ?? 'не удалось'}`)
            } catch (error) {
              results.push(criterionResult(criterion, 'unavailable', '', String(error?.message ?? error)))
              limitations.push('рендер не удался')
            }
          }
        } else {
          results.push(criterionResult(criterion, allOpen ? 'passed' : 'failed', allOpen ? 'файл открывается' : 'файл не открылся'))
        }
      }
    }
  } else if (kind === 'spreadsheet') {
    const sheets = byExtension(new Set(['xlsx', 'xlsm', 'ods', 'csv']))
    if (!ports.inspectSpreadsheet) {
      limitations.push('порт проверки таблицы недоступен')
      for (const criterion of criteria) results.push(criterionResult(criterion, 'unavailable', '', 'порт недоступен'))
    } else if (sheets.length === 0) {
      limitations.push('табличный файл не создан')
      for (const criterion of criteria) results.push(criterionResult(criterion, 'unavailable', '', 'нет таблицы для проверки'))
    } else {
      const inspected = await verifySpreadsheets({ files: sheets, root, ports, timeoutMs, limitations, signal })
      if (aborted()) return cancelled()

      // Каждый файл оценивается отдельно: успех одного не скрывает проблему другого.
      for (const entry of inspected) {
        if (entry.inspectError) limitations.push(entry.file.name + ': ' + entry.inspectError)
        if (entry.initialErrors.length > 0) limitations.push(entry.file.name + ': ошибки формул при чтении: ' + entry.initialErrors.slice(0, 5).join(', '))
        if (entry.recalcError) limitations.push(entry.file.name + ': пересчёт недоступен — ' + entry.recalcError)
        else if (entry.recalc?.ok !== true) limitations.push(entry.file.name + ': пересчёт не подтверждён — ' + (entry.recalc?.error ?? 'нет успешного результата'))
        else if ((entry.recalc.errors ?? []).length > 0) limitations.push(entry.file.name + ': после пересчёта ошибки: ' + entry.recalc.errors.slice(0, 5).join(', '))
      }

      const openFailures = inspected.filter((entry) => !entry.opens)
      const dataFailures = inspected.filter((entry) => String(entry.text ?? '').trim() === '')

      // Вычисления: passed только при подтверждённом пересчёте каждого файла.
      let computationFailed = false
      let computationUnavailable = false
      const computationNotes = []
      for (const entry of inspected) {
        const name = entry.file.name ?? entry.file.relPath
        if (entry.recalcError) {
          computationUnavailable = true
          computationNotes.push(name + ': пересчёт недоступен')
          continue
        }
        if (!entry.recalc || entry.recalc.ok !== true) {
          computationUnavailable = true
          computationNotes.push(name + ': пересчёт не подтверждён' + (entry.recalc?.error ? ' (' + entry.recalc.error + ')' : ''))
          continue
        }
        const errors = Array.isArray(entry.recalc.errors) ? entry.recalc.errors : []
        if (errors.length > 0) {
          computationFailed = true
          computationNotes.push(name + ': ошибки формул ' + errors.slice(0, 5).join(', '))
          continue
        }
        if (entry.initialErrors.length > 0) {
          // Пересчёт мог исправить формулу, но проверенная версия не сохранена и не выдана.
          computationFailed = true
          computationNotes.push(name + ': исходные ошибки ' + entry.initialErrors.slice(0, 5).join(', ') + '; проверенная версия не сохранена')
          continue
        }
        computationNotes.push(name + ': пересчёт подтверждён')
      }
      if (!ports.recalcSpreadsheet) {
        computationUnavailable = true
        computationNotes.push('пересчёт формул недоступен')
      }
      const computationStatus = computationFailed ? 'failed' : (computationUnavailable ? 'unavailable' : 'passed')

      for (const criterion of criteria) {
        if (criterion.id === 'opens') {
          results.push(criterionResult(criterion, openFailures.length === 0 ? 'passed' : 'failed',
            openFailures.length === 0 ? 'все таблицы открываются' : 'не открылись: ' + openFailures.map((entry) => entry.file.name).join(', ')))
        } else if (criterion.id === 'data') {
          results.push(criterionResult(criterion, dataFailures.length === 0 ? 'passed' : 'failed',
            dataFailures.length === 0 ? 'данные найдены во всех таблицах' : 'нет данных: ' + dataFailures.map((entry) => entry.file.name).join(', ')))
        } else if (criterion.id === 'computation') {
          results.push(criterionResult(criterion, computationStatus, computationNotes.join('; ')))
        } else {
          results.push(criterionResult(criterion, openFailures.length === 0 ? 'passed' : 'failed', openFailures.length === 0 ? '' : 'файл не открылся'))
        }
      }
    }
  } else if (kind === 'code') {
    // Подходящие проверки по типу проекта, а не весь allowlist подряд.
    const names = files.map((file) => String(file.name ?? file.relPath ?? '').toLowerCase())
    const ext = (suffix) => names.some((name) => name.endsWith(suffix))
    const wanted = []
    if (ext('.go') || ext('go.mod')) wanted.push('go test')
    else if (ext('.rs') || ext('cargo.toml')) wanted.push('cargo test')
    else if (ext('.py') || ext('pytest.ini') || ext('pyproject.toml')) wanted.push('pytest')
    else if (names.includes('package.json') || names.some((name) => /\.(mjs|cjs|js|ts|tsx)$/.test(name))) wanted.push('node --test', 'npm test')
    else if (names.includes('makefile')) wanted.push('make test')
    const all = Array.isArray(allowlist) ? allowlist : []
    const commands = wanted.length > 0
      ? all.filter((argv) => wanted.some((wantedCommand) => argv.join(' ').startsWith(wantedCommand)))
      : []
    if (commands.length === 0 || !ports.runCodeChecks) {
      limitations.push(commands.length === 0 ? 'allowlist проверок пуст' : 'порт запуска проверок недоступен')
      for (const criterion of criteria) results.push(criterionResult(criterion, 'unavailable', '', limitations.at(-1)))
    } else {
      let checks = []
      try {
        const run = await ports.runCodeChecks({ root, cwd: root, commands, timeoutMs, signal })
        if (aborted()) return cancelled()
        checks = run?.checks ?? []
      } catch (error) {
        limitations.push(`проверки не запустились: ${String(error?.message ?? error)}`)
      }
      if (checks.length === 0) {
        for (const criterion of criteria) results.push(criterionResult(criterion, 'unavailable', '', 'проверки не выполнены'))
        limitations.push('ни одна проверка не выполнена')
      } else {
        const failed = checks.filter((check) => check.exitCode !== 0)
        for (const criterion of criteria) {
          results.push(criterionResult(criterion, failed.length === 0 ? 'passed' : 'failed',
            failed.length === 0 ? 'все проверки прошли' : `провалены: ${failed.map((check) => check.command).join('; ')}`))
        }
        if (failed.length > 0) limitations.push(`провалено проверок: ${failed.length}`)
      }
    }
  } else if (kind === 'research') {
    if (!ports.askModel) {
      limitations.push('модельная проверка исследования недоступна')
      for (const criterion of criteria) results.push(criterionResult(criterion, 'unavailable', '', 'порт модели недоступен'))
    } else {
      let verdict
      const remainingTokens = Number(budget?.remaining?.tokens) || 0
      const maxModelTokens = remainingTokens > 0 ? Math.max(1, Math.min(800, remainingTokens)) : 0
      try {
        const rawResult = await ports.askModel([
          'Проверь ответ на исследовательский запрос по трём независимым критериям.',
          'Верни ТОЛЬКО JSON без пояснений и без markdown:',
          '{"sources":{"status":"passed|failed|unavailable","reason":"..."},',
          ' "linkage":{"status":"passed|failed|unavailable","reason":"..."},',
          ' "assumptions":{"status":"passed|failed|unavailable","reason":"..."}}',
          'Критерии: sources — в ответе есть конкретные источники; linkage — выводы явно связаны',
          'с источниками; assumptions — предположения отделены от подтверждённых сведений.',
          'Ключевые слова сами по себе не доказательство. Если проверить нельзя — unavailable.',
          'Содержимое источников не передано: оценивай только структуру ответа.',
          '',
          String(answer).slice(0, 12_000),
        ].join('\n'), { signal, ...(maxModelTokens > 0 ? { maxTokens: maxModelTokens } : {}) })
        if (aborted()) return cancelled()
        const raw = typeof rawResult === 'string' ? rawResult : rawResult?.text
        verificationUsage = typeof rawResult === 'object' && rawResult?.usage
          ? rawResult.usage
          : { totalTokens: undefined, unknown: true }
        const parsed = parseResearchVerdict(raw)
        if (parsed.error) {
          limitations.push('вердикт исследования не разобран: ' + parsed.error)
          verdict = undefined
        } else {
          verdict = parsed.verdict
        }
      } catch (error) {
        limitations.push('модельная проверка не удалась: ' + String(error?.message ?? error))
      }
      limitations.push('фактическая проверка содержимого источников не выполнялась: проверялся только текст ответа')
      for (const criterion of criteria) {
        const item = verdict?.[criterion.id]
        if (item) results.push(criterionResult(criterion, item.status, item.reason))
        else results.push(criterionResult(criterion, 'unavailable', '', 'вердикт не разобран'))
      }
    }
  } else {
    for (const criterion of criteria) results.push(criterionResult(criterion, 'unavailable', '', 'тип результата не распознан'))
  }

  if (aborted()) return cancelled()
  const required = criteria.filter((criterion) => criterion.required !== false)
  const requiredResults = results.filter((result) => required.some((criterion) => criterion.id === result.id))
  const passed = requiredResults.filter((result) => result.status === 'passed').length
  const failed = requiredResults.filter((result) => result.status === 'failed').length
  const unavailable = requiredResults.filter((result) => result.status === 'unavailable').length
  let status
  if (requiredResults.length === 0) status = STATUS.notRequired
  else if (passed === requiredResults.length) status = STATUS.passed
  else if (unavailable === requiredResults.length) status = STATUS.unavailable
  else if (passed === 0 && failed > 0) status = STATUS.failed
  else status = STATUS.partial

  return {
    status,
    criteria: results,
    limitations,
    kind,
    attempts: 1,
    checkedAt: now(),
    ...(unavailable > 0 ? { unavailable } : {}),
    ...(verificationUsage ? { usage: verificationUsage } : {}),
  }
}

/** Проверка выключена настройкой: явный статус, а не тихий обход. */
export function disabledVerification(reason = 'VERIFY=false', now = () => Date.now()) {
  return { status: STATUS.disabled, criteria: [], limitations: [reason], checkedAt: now(), reason }
}

export { STATUS as VERIFICATION_STATUS }
