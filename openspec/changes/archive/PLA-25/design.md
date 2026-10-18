# Техническое решение

- `registry.describe()` возвращает копии метаданных всех исполнителей; `dsh`
  получает `limits` из конфигурации и `modelProfile` из MODEL_NAME.
- `createDshExecutor({runner, limits, modelProfile, tools})` сохраняет контракт
  `execute` и добавляет метаданные.
- `executeTask` при `WORKSPACE_PER_TASK=true` и отсутствии продолжения вопроса
  начинает fresh session (`sessionId=undefined`), чтобы параллельные задачи одного
  чата не делили контекст; continuation сохраняет сессию.
- `pruneTaskWorkspaces(baseDir,{retentionDays,now,activeIds})` удаляет старые
  `tasks/<id>`, не трогая активные/незавершённые; вызывается на старте.
- `TASK_PER_USER_CONCURRENCY` ограничивает число незавершённых задач одного userId
  (0 = выключено); проверка в enqueueJob по журналу и очереди.
