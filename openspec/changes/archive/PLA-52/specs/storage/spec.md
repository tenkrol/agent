# Дельта для домена storage

## MODIFIED Requirements

### Requirement: Журнал сохраняет тип операции
Долговечная запись задания ДОЛЖНА сохранять поля, которые выбирают обработчик и
ревизию операции: `kind`, `requestId`, `revision`, `retry`.

#### Scenario: Перезапуск с implement-задачей в очереди
- GIVEN implement-задача записана в JSONL как queued
- WHEN сервис перезапускается
- THEN восстанавливаются её kind, requestId, revision и retry
- AND задача передаётся implementer, а не обычному DSH-обработчику.
