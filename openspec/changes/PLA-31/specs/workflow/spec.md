# Дельта для домена workflow

## ADDED Requirements

### Requirement: Реализация заявки в отдельной ветке
Система ДОЛЖНА по заявке запускать DSH в изолированном checkout компонента и
публиковать изменения в ветке `impl/<REQ>-<changeId>`, не трогая main.

#### Scenario: Успешная реализация
- GIVEN заявка с компонентными спеками
- WHEN запускается implement
- THEN DSH работает в каталоге компонента
- AND изменения уходят в ветку impl, main не меняется.

#### Scenario: Ошибка DSH
- GIVEN DSH завершился ошибкой
- WHEN implement завершается
- THEN ветка impl не публикуется.
