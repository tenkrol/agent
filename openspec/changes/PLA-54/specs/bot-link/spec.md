# Дельта для домена bot-link

## ADDED Requirements

### Requirement: Principal задачи независим от маршрута доставки
Контракт v2 ДОЛЖЕН принимать проверенный `principal.userId/scopeId` отдельно от
`route`. Activity, usage и персональные лимиты ДОЛЖНЫ использовать principal.

#### Scenario: Задача второго пользователя
- GIVEN `route.chatId=202`, `principal.userId=202` и системный alert chat `101`
- WHEN задача ставится через v2
- THEN результат доставляется по route
- AND задача и activity принадлежат пользователю 202
- AND расход записывается пользователю 202.

#### Scenario: Старый клиент
- GIVEN v2-запрос не содержит principal
- WHEN задача ставится в очередь
- THEN владелец выводится из проверенного маршрута доставки
- AND запрос не отклоняется.
