# Дельта для домена storage

## ADDED Requirements

### Requirement: Журнал активности
Хранилище ДОЛЖНО вести bounded журнал событий задач без секретов с полями
taskId/agent/stage/status/tokens и отдавать последние события с фильтрами.

#### Scenario: Событие задачи
- GIVEN задача завершилась
- WHEN пишется событие completed
- THEN оно доступно в recent() и не содержит секретов.
