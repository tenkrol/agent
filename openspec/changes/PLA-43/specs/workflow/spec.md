# Дельта для домена workflow

## ADDED Requirements

### Requirement: Установка не выдаётся за merge
Deploy ДОЛЖЕН отдельно сообщать merged/checked/published SHA и installed.state;
неудачный healthcheck откатывается и не становится healthy.

#### Scenario: Healthcheck failed
- GIVEN install вернул healthy=false
- WHEN deploy завершается
- THEN rollback вызван
- AND состояние rolled_back, ok=false.
