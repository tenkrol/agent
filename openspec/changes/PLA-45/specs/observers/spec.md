# Дельта для домена observers

## ADDED Requirements

### Requirement: Реестр источников
Наблюдатели ДОЛЖНЫ отдавать по каждому источнику статус, время проверки, свежесть и
доказательства; недоступный источник явно помечается unavailable.

#### Scenario: Источник недоступен
- GIVEN GitHub недоступен
- WHEN выполняется observe
- THEN source.status=unavailable и error указан
- AND это не считается «изменений нет».
