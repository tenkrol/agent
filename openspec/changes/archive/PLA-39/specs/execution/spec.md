# Дельта для домена execution

## ADDED Requirements

### Requirement: Checkout согласованного SHA
Перед DSH рабочая копия компонента ДОЛЖНА быть переключена на specificationCommit
из approval; несовпадение HEAD и SHA — ошибка.

#### Scenario: Несовпадение SHA
- GIVEN HEAD не равен согласованному SHA
- WHEN начинается реализация
- THEN DSH не запускается.
