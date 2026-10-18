# Дельта для домена bot-link

## ADDED Requirements

### Requirement: Health сообщает релиз
`GET /health` и `/v1/health` ДОЛЖНЫ отдавать `release`, если он известен; поле не
содержит путей и секретов.

#### Scenario: Релиз известен
- GIVEN bridge создан с release
- WHEN вызывается health
- THEN в ответе есть release.
