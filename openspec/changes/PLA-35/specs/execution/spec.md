# Дельта для домена execution

## ADDED Requirements

### Requirement: Файловый исполнитель
ДОЛЖЕН существовать исполнитель files с capabilities files/documents/office,
своим префиксом инструкций и профилем модели.

#### Scenario: Реестр
- GIVEN files зарегистрирован
- WHEN вызывается describe()
- THEN видны id files, capabilities и modelProfile.
