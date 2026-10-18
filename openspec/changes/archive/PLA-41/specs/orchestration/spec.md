# Дельта для домена orchestration

## ADDED Requirements

### Requirement: Профиль не выдаётся за действующий без поддержки
Если DSH не умеет переключать модель на вызов, исполнитель ДОЛЖЕН показывать
`profileStatus: unsupported`, а не действующий профиль.

#### Scenario: describe
- GIVEN files/monitor/personal на общем headless runner
- WHEN вызывается describe()
- THEN profileStatus=unsupported виден в реестре.
