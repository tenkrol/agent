# Дельта для домена bot-link

## ADDED Requirements

### Requirement: API активности
Мост ДОЛЖЕН отдавать `GET /v1/agents` и `GET /v1/activity` с тем же токеном,
пагинацией/фильтрами и без секретов.

#### Scenario: Чтение активности
- GIVEN токен и события
- WHEN вызывается /v1/activity?limit=10
- THEN возвращаются последние события
- AND без токена — 401.
