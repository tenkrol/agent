# Дельта для домена policy

## ADDED Requirements

### Requirement: Политика действий
Действия ДОЛЖНЫ подчиняться режиму observe/prepare/execute/approval, allowlist,
бюджету и общему выключателю; без разрешения действие не выполняется.

#### Scenario: Наблюдение
- GIVEN режим observe
- WHEN запрашивается действие
- THEN allowed=false.
