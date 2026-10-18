# Дельта для домена orchestration

## ADDED Requirements

### Requirement: Маршрутизация задач наблюдения
Задачи о состоянии хоста/сервисов ДОЛЖНЫ попадать в исполнителя monitor.

#### Scenario: Проверка сервера
- GIVEN зарегистрирован monitor
- WHEN задача просит проверить диск и память
- THEN selectExecutor выбирает monitor.
