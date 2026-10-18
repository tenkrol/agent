# Дельта для домена orchestration

## ADDED Requirements

### Requirement: Безопасное восстановление SQLite
При старте без новых задач orchestration ДОЛЖЕН восстановить pending/running из SQLite,
дождаться истечения аренды и перезапустить выполнение; workers>1 отклоняется до изоляции
workspace/runner/progress.

#### Scenario: Рестарт до TTL
- GIVEN running-задача с арендой, сервис упал
- WHEN сервис поднялся до TTL и новых задач нет
- THEN после истечения аренды задача снова захватывается
- AND выполняется один раз.
