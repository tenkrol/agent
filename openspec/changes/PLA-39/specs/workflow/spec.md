# Дельта для домена workflow

## ADDED Requirements

### Requirement: Реализация только согласованной ревизии
DSH ДОЛЖЕН запускаться только для заявки с approval, совпадающим по revision и
точным SHA компонентных спецификаций; checkout выполняется на этом SHA.

#### Scenario: Черновик
- GIVEN заявка draft без approval
- WHEN вызывается implement
- THEN DSH не запускается.

#### Scenario: Спека изменилась
- GIVEN SHA спецификации изменён после approval
- WHEN вызывается implement
- THEN запуск отклоняется.
