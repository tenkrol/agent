# Дельта для домена workflow

## ADDED Requirements

### Requirement: Отметка E5 implementation check в README
README компонента ДОЛЖЕН содержать строку `E5 implementation check`, чтобы результат
реализации E5 был проверяем по документации.

#### Scenario: Проверка отметки в README
- GIVEN изменение PLA-32 реализовано
- WHEN читается README или запускается `test/readme.test.mjs`
- THEN в README есть строка `E5 implementation check`
- AND тест завершается успешно.
