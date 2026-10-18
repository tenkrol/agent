# Дельта для домена orchestration

## ADDED Requirements

### Requirement: Выбор исполнителя по задаче
Оркестратор ДОЛЖЕН выбирать исполнителя через `selectExecutor`; при отсутствии
выбора используется dsh. Repair идёт тем же исполнителем.

#### Scenario: Файловая задача
- GIVEN зарегистрирован files
- WHEN selectExecutor выбирает files
- THEN execute и repair вызывают files.
