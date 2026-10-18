# Дельта для домена orchestration

## ADDED Requirements

### Requirement: Реестр исполнителей с метаданными
Реестр ДОЛЖЕН отдавать по каждому исполнителю id, capabilities, limits,
modelProfile, tools и status; метаданные доступны для API/диагностики.

#### Scenario: Диагностика
- GIVEN DSH-исполнитель зарегистрирован
- WHEN запрашивается describe()
- THEN видны его лимиты, профиль модели и инструменты.
