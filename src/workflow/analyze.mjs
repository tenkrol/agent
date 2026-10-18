/**
 * E4: предварительный анализ заявки без LLM.
 *
 * Определяет затронутые компоненты по русским/техническим маркерам. Это не
 * замена инженерному разбору: при неоднозначности результат несёт question,
 * и заявка остаётся draft до ответа владельца.
 */
const ASSISTANT = [
  'бот', 'telegram', 'телеграм', 'команд', 'кнопк', 'панел', 'приложен', 'мини-прилож',
  'напомин', 'календар', 'чат', 'интерфейс', 'сообщен', 'вк', 'vk', 'webapp', 'меню',
]
const AGENT = [
  'агент', 'dsh', 'очеред', 'файл', 'код', 'репозитор', 'github', 'git', 'деплой',
  'релиз', 'проверк', 'верификац', 'openspec', 'спецификац', 'xlsx', 'docx', 'презентац',
  'аренд', 'воркер', 'workspace', 'sqlite', 'задач',
]

const hits = (text, words) => words.filter((word) => text.includes(word))

export function analyzeRequest(text) {
  const clean = String(text ?? '').toLowerCase()
  const assistantHits = hits(clean, ASSISTANT)
  const agentHits = hits(clean, AGENT)
  const components = []
  if (assistantHits.length > 0) {
    components.push({ repository: 'tenkrol/assistant', changePrefix: 'PLB', reason: `маркеры: ${assistantHits.slice(0, 4).join(', ')}` })
  }
  if (agentHits.length > 0) {
    components.push({ repository: 'tenkrol/agent', changePrefix: 'PLA', reason: `маркеры: ${agentHits.slice(0, 4).join(', ')}` })
  }
  const ambiguous = components.length === 0
  return {
    components,
    ambiguous,
    question: ambiguous
      ? 'Не понял, какой компонент затрагивает заявка: бот (assistant) или агент (agent)? Уточните, пожалуйста.'
      : undefined,
    hits: { assistant: assistantHits, agent: agentHits },
  }
}
