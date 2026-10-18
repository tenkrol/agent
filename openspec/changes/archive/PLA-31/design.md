# Решение

- `createImplementService`: `loadRequest` (clone spec repo на req-ветку, manifest+текст),
  для каждого компонента `clone` на spec-ветку, `runner.run` с промптом заявки,
  `commitAndPush` ветки `impl/...`; ошибка DSH останавливает без пуша.
- Промпт запрещает менять чужие репозитории, требует тесты и сообщает, если изменений нет.
- API и бот вызывают сервис по requestId; PR — compare URL (E3 token ограничение).
