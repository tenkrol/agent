# Дельта для домена orchestration

## ADDED Requirements

### Requirement: Профили агентов
Оркестратор ДОЛЖЕН публиковать профиль модели/лимиты исполнителя в describe().

#### Scenario: describe
- GIVEN настроен профиль dsh
- WHEN вызывается describe()
- THEN profile виден в метаданных.
