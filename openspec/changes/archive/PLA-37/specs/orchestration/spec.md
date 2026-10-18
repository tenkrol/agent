# Дельта для домена orchestration

## ADDED Requirements

### Requirement: Маршрутизация личных задач
Личные задачи (память, предпочтения, напоминания) ДОЛЖНЫ попадать в personal.

#### Scenario: Вопрос о памяти
- GIVEN personal зарегистрирован
- WHEN задача спрашивает, что известно владельцу
- THEN выбирается personal.
