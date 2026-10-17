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

/**
 * Проверить результат.
 *
 * @param {object} input - `taskText`, `files` (метаданные с `name`/`relPath`),
 *   `answer`, `root`, `ports`, `allowlist`, `timeoutMs`, `now`.
 * @returns {Promise<object>} результат проверки.
 */
export async function verify({ taskText = '', files = [], answer = '', root, ports = {}, allowlist = [], timeoutMs = 300_000, now = () => Date.now() } = {}) {
  const { kind, criteria } = deriveCriteria({ taskText, files })
  const limitations = []
  const results = []

  if (criteria.length === 0) {
    return { status: STATUS.notRequired, criteria: [], limitations: [], checkedAt: now(), kind }
  }

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
          inspected.push({ file, ...(await ports.inspectDocument({ root, path: file.relPath, name: file.name })) })
        } catch (error) {
          inspected.push({ file, opens: false, text: '', error: String(error?.message ?? error) })
        }
      }
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
              const rendered = await ports.renderDocument({ root, path: docs[0]?.relPath, to: 'pdf' })
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
    } else {
      let opens = false
      let text = ''
      let errors = []
      for (const file of sheets) {
        try {
          const inspected = await ports.inspectSpreadsheet({ root, path: file.relPath, name: file.name })
          opens = opens || inspected?.opens === true
          text += `\n${inspected?.text ?? ''}`
        } catch (error) {
          limitations.push(`таблица: ${String(error?.message ?? error)}`)
        }
      }
      if (ports.recalcSpreadsheet && sheets.length > 0) {
        try {
          const recalc = await ports.recalcSpreadsheet({ root, path: sheets[0].relPath, timeoutMs })
          opens = opens || recalc?.opens === true
          errors = recalc?.errors ?? []
          text += `\n${recalc?.text ?? ''}`
        } catch (error) {
          limitations.push(`пересчёт формул: ${String(error?.message ?? error)}`)
        }
      } else {
        limitations.push('пересчёт формул недоступен')
      }
      for (const criterion of criteria) {
        if (criterion.id === 'opens') results.push(criterionResult(criterion, opens ? 'passed' : 'failed', opens ? 'таблица открывается' : 'таблица не открылась'))
        else if (criterion.id === 'data') results.push(criterionResult(criterion, text.trim() !== '' ? 'passed' : 'failed', text.trim() !== '' ? 'данные найдены' : 'данных нет'))
        else if (criterion.id === 'computation') {
          if (errors.length > 0) results.push(criterionResult(criterion, 'failed', `ошибки формул: ${errors.slice(0, 5).join(', ')}`))
          else results.push(criterionResult(criterion, 'passed', 'ошибки формул не найдены'))
        } else results.push(criterionResult(criterion, opens ? 'passed' : 'failed', ''))
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
        const run = await ports.runCodeChecks({ root, cwd: root, commands, timeoutMs })
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
    const hasSources = /источник|ссылки|литература|sources/i.test(String(answer))
    if (!ports.askModel) {
      limitations.push('модельная проверка исследования недоступна')
      for (const criterion of criteria) results.push(criterionResult(criterion, 'unavailable', '', 'порт модели недоступен'))
    } else {
      let verdict = ''
      try {
        verdict = String(await ports.askModel([
          'Проверь ответ на исследовательский запрос. Ответь одной строкой:',
          'ИСТОЧНИКИ: да|нет; СВЯЗЬ: да|нет; ПРЕДПОЛОЖЕНИЯ: да|нет',
          '',
          String(answer).slice(0, 12_000),
        ].join('\n'))).toLowerCase()
      } catch (error) {
        limitations.push(`модельная проверка не удалась: ${String(error?.message ?? error)}`)
      }
      const sourcesOk = /источники?\s*[:—-]?\s*(да|yes|есть)/i.test(verdict) || hasSources
      for (const criterion of criteria) {
        if (criterion.id === 'sources') results.push(criterionResult(criterion, sourcesOk ? 'passed' : 'failed', sourcesOk ? 'источники есть' : 'источников нет'))
        else results.push(criterionResult(criterion, /предполож/i.test(verdict) ? 'passed' : 'unavailable', verdict.slice(0, 120)))
      }
    }
  } else {
    for (const criterion of criteria) results.push(criterionResult(criterion, 'unavailable', '', 'тип результата не распознан'))
  }

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
  }
}

/** Проверка выключена настройкой: явный статус, а не тихий обход. */
export function disabledVerification(reason = 'VERIFY=false', now = () => Date.now()) {
  return { status: STATUS.disabled, criteria: [], limitations: [reason], checkedAt: now(), reason }
}

export { STATUS as VERIFICATION_STATUS }
