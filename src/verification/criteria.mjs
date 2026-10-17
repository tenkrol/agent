/**
 * Критерии результата: что именно проверять.
 *
 * Критерий всегда выводится из фразы владельца или из минимальной проверки типа
 * результата; придумывать требования сверх запроса запрещено. Домен чистый: он не
 * знает про процессы, сеть и файлы — только текст задачи и метаданные результата.
 */

const DOC_EXT = new Set(['docx', 'docm', 'odt', 'pdf', 'doc'])
const SHEET_EXT = new Set(['xlsx', 'xlsm', 'ods', 'csv'])
const CODE_EXT = new Set(['mjs', 'js', 'cjs', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'rb', 'php', 'sh'])
const CODE_WORDS = /правк[аи] кода|измени код|тест|линтер|сборк|рефактор|исправь баг/i
const RESEARCH_WORDS = /исследован|проанализируй|анализ|обзор|сравни|источник|ссылк|фактчек/i
const SOURCES_WORDS = /источник|ссылк|подтвержд|обоснован/i
const FORMAT_WORDS = /формат|docx|xlsx|pdf|csv|pptx|таблиц|документ/i

const extensionOf = (name) => String(name ?? '').split('.').pop().toLowerCase()

/**
 * Тип результата по файлам и формулировке.
 *
 * @returns {'document'|'spreadsheet'|'code'|'research'|'none'} тип.
 */
export function detectResultKind({ taskText = '', files = [] } = {}) {
  const exts = files.map((file) => extensionOf(file.name ?? file.relPath ?? ''))
  if (exts.some((ext) => DOC_EXT.has(ext))) return 'document'
  if (exts.some((ext) => SHEET_EXT.has(ext))) return 'spreadsheet'
  if (exts.some((ext) => CODE_EXT.has(ext))) return 'code'
  const text = String(taskText)
  if (CODE_WORDS.test(text)) return 'code'
  if (RESEARCH_WORDS.test(text)) return 'research'
  return 'none'
}

/** Разделы, которые владелец назвал явно. */
export function sectionsFrom(taskText = '') {
  const text = String(taskText)
  const found = new Set()
  const known = ['итоги', 'риски', 'план', 'введение', 'заключение', 'источники', 'выводы', 'приложения']
  // \b не работает для кириллицы в JS, поэтому проверяем вхождение слова в нижнем регистре.
  for (const word of known) if (text.toLowerCase().includes(word)) found.add(word)
  const match = text.match(/(?:раздел(?:ами|ы|ов|ах)?|структур[аы]|содержани[ея])\s*[:\-—]?\s*([^\n.]{3,160})/i)
  if (match) {
    const tail = match[1].replace(/^(есть|должны быть|нужны|с)\s+/i, '')
    for (const part of tail.split(/[,;]|\s+и\s+/i)) {
      const clean = part.replace(/[«»"']/g, '').trim().toLowerCase()
      // Раздел — это короткое имя (обычно одно-два слова), а не фраза-описание.
      const words = clean.split(/\s+/).filter(Boolean)
      if (clean.length >= 2 && clean.length <= 25 && words.length <= 2 && !/^(и|или|текст|файл|документ)$/.test(clean)) {
        found.add(clean)
      }
    }
  }
  return [...found]
}

/**
 * Критерии для одного результата.
 *
 * @returns {{kind: string, criteria: Array<object>, ambiguous: boolean}}
 */
export function deriveCriteria({ taskText = '', files = [] } = {}) {
  const kind = detectResultKind({ taskText, files })
  const text = String(taskText)
  const criteria = []
  const add = (criterion) => criteria.push({ required: true, ...criterion })

  if (kind === 'document') {
    add({ id: 'opens', text: 'файл открывается', kind: 'format', source: 'минимальная проверка типа' })
    const sections = sectionsFrom(text)
    if (sections.length > 0) {
      add({ id: 'sections', text: `есть разделы: ${sections.join(', ')}`, kind: 'sections', sections, source: 'из запроса' })
    }
    if (/оформлен|отображ|выглядит|вёрстк|верстк/i.test(text)) {
      add({ id: 'render', text: 'оформление проверено по отображению', kind: 'format', source: 'из запроса' })
    }
  } else if (kind === 'spreadsheet') {
    add({ id: 'opens', text: 'файл открывается', kind: 'format', source: 'минимальная проверка типа' })
    add({ id: 'data', text: 'нужные данные присутствуют', kind: 'data', source: 'минимальная проверка типа' })
    add({ id: 'computation', text: 'формулы пересчитаны, ошибок формул нет', kind: 'computation', source: 'минимальная проверка типа' })
  } else if (kind === 'code') {
    add({ id: 'checks', text: 'подходящие проверки кода выполнены', kind: 'checks', source: 'минимальная проверка типа' })
  } else if (kind === 'research') {
    add({ id: 'sources', text: 'в ответе есть источники', kind: 'sources', source: 'минимальная проверка типа' })
    add({ id: 'linkage', text: 'выводы связаны с источниками', kind: 'sources', source: 'минимальная проверка типа' })
    add({ id: 'assumptions', text: 'предположения отделены от подтверждённых сведений', kind: 'sources', source: 'минимальная проверка типа' })
  }

  if (SOURCES_WORDS.test(text) && !criteria.some((criterion) => criterion.kind === 'sources')) {
    add({ id: 'sources', text: 'есть источники', kind: 'sources', source: 'из запроса' })
  }
  if (FORMAT_WORDS.test(text) && !criteria.some((criterion) => criterion.kind === 'format')) {
    const match = text.match(/\b(docx|xlsx|pdf|csv|pptx|odt|ods)\b/i)
    add({ id: 'format', text: 'формат результата соблюдён', kind: 'format', ext: match ? match[1].toLowerCase() : undefined, source: 'из запроса' })
  }
  return { kind, criteria, ambiguous: false }
}

/** Нужна ли проверка вообще: простой текстовый ответ без артефактов не проверяется. */
export function isVerificationNeeded({ taskText = '', files = [], criteria = [] } = {}) {
  if (files.length > 0) return true
  if (criteria.some((criterion) => criterion.source === 'из запроса')) return true
  const kind = detectResultKind({ taskText, files })
  return kind !== 'none'
}
