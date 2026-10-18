# Дельта для домена workflow

## ADDED Requirements

### Requirement: Ready-спецификация до согласования
Согласование ДОЛЖНО быть возможно только после DSH-исследования кода и готовой
спецификации с критериями; draft не согласуется.

#### Scenario: Draft approval
- GIVEN status draft
- WHEN вызывается approve
- THEN согласование отклоняется.

#### Scenario: Specify
- GIVEN draft с компонентами
- WHEN вызывается specify
- THEN DSH заполняет спеку в spec-ветке
- AND status становится ready с новыми SHA.
