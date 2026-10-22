# Дельта для домена orchestration

## MODIFIED Requirements

### Requirement: Исправление сохраняет workspace задачи
Повторное исполнение после неуспешной проверки ДОЛЖНО использовать тот же
`workspaceDir`, что первоначальный запуск.

#### Scenario: Repair изолированной задачи
- GIVEN основной запуск работал в `tasks/<id>`
- WHEN проверка требует repair
- THEN repair запускается в `tasks/<id>`
- AND не читает и не пишет общий workspace.
