# Дельта для домена benefit

## ADDED Requirements

### Requirement: Оценка пользы
Система ДОЛЖНА сравнивать фактическое до/после и фиксировать verdict/evidence;
отсутствие данных не выдаётся за улучшение.

#### Scenario: Нет данных
- GIVEN before или after отсутствует
- WHEN оценивается польза
- THEN verdict=no_data.
