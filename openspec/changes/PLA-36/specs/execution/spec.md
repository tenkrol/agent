# Дельта для домена execution

## ADDED Requirements

### Requirement: Исполнитель monitor
ДОЛЖЕН существовать monitor с capabilities monitor/host/alerts и профилем модели.

#### Scenario: describe
- GIVEN monitor зарегистрирован
- WHEN вызывается describe()
- THEN видны id monitor и его capabilities.
