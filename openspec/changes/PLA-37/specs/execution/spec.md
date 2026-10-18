# Дельта для домена execution

## ADDED Requirements

### Requirement: Персональный исполнитель
ДОЛЖЕН существовать personal с capabilities personal/memory/reminders и доступом
к фактам памяти в промпте.

#### Scenario: describe
- GIVEN personal зарегистрирован
- WHEN вызывается describe()
- THEN видны id personal и capabilities.
