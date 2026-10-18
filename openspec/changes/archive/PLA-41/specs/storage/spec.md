# Дельта для домена storage

## ADDED Requirements

### Requirement: Фактическая модель в usage
Событие расхода ДОЛЖНО содержать фактический provider/model, роль и task/attempt id;
неизвестный расход не считается нулевым.

#### Scenario: model_usage
- GIVEN выполняется задача personal
- WHEN пишется model_usage
- THEN событие содержит role=personal, provider/model и taskId.
