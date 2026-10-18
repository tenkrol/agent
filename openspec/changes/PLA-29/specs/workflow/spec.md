# Дельта для домена workflow

## ADDED Requirements

### Requirement: Draft заявки
Система ДОЛЖНА из текста владельца создать draft-заявку с requestId, revision,
request/proposal/acceptance и manifest; manifest проверяется до записи.

#### Scenario: Невалидные компоненты
- GIVEN в компоненте нет specificationCommit
- WHEN создаётся draft
- THEN запись не выполняется
- AND возвращается понятная ошибка.
