# PLA-39 / F2: согласованная ревизия перед реализацией

Основание: review F2. `implement` запускался на draft и не проверял SHA спецификации.

## Что меняется
- `request-state`: состояния draft→approved→ready→running→verified→release_pending→released,
  failed/cancelled; проверка manifest и согласования (identity/time/revision/SHA).
- implement: проверка до DSH, checkout точного `specificationCommit`, запись
  running/verified/failed в ветку заявки; повтор без retry запрещён.
- `/v1/approve` записывает approval.json и approved-статус.
