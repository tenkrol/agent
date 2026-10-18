# Дельта для домена config

## ADDED Requirements

### Requirement: Параллельные workers запрещены без изоляции
`QUEUE_WORKERS>1` ДОЛЖЕН отклоняться на старте, пока workspace/runner/progress не
изолированы на задачу.

#### Scenario: Небезопасная настройка
- GIVEN QUEUE_WORKERS=2
- WHEN сервис стартует
- THEN старт прерывается понятной ошибкой
- AND задачи не запускаются параллельно.
