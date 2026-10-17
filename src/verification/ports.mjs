/**
 * Сборка портов проверки (PLA-21).
 *
 * Обёртки обязаны передавать `options` (signal, maxTokens) в транспорт: иначе
 * отмена не доходит до уже запущенного HTTP-запроса. Здесь одна точка сборки,
 * чтобы это можно было проверить тестом на реальном клиенте.
 */
export function createVerifyPorts({
  modelClient,
  inspectDocument,
  inspectSpreadsheet,
  recalcSpreadsheet,
  renderDocument,
  runCodeChecks,
} = {}) {
  return {
    inspectDocument,
    inspectSpreadsheet,
    recalcSpreadsheet,
    renderDocument,
    runCodeChecks,
    askModel: modelClient?.enabled
      ? (prompt, options) => modelClient.askModel(prompt, options)
      : undefined,
  }
}
