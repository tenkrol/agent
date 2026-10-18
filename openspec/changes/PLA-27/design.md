# Техническое решение

- `tools/request-manifest.mjs`: читает `manifest.json`, проверяет схему:
  `schemaVersion=1`, `requestId /^REQ-\d{4,}$/`, `revision>=1`, компоненты с
  `tenkrol/<repo>`, `changeId /^(PLA|PLB)-\d+$/`, `baseCommit`/`specificationCommit`
  как 40-hex SHA, `executionPolicy` (`reviewed`|`policy`), `releasePolicy`.
- Секреты: ключи token/password/secret/apiKey в значениях запрещены; ошибки без
  вывода значений.
- GitHub-идентичность: отдельный deploy key/App с доступом только к выбранным
  репозиториям; ключ не попадает в промпты.
- Синхронизация: заявка в GitHub — источник требований; оперативная очередь в SQLite;
  повторный подбор идемпотентен по requestId+revision.
