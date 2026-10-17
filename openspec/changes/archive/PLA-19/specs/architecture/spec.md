# Дельта для домена architecture

## MODIFIED Requirements

### Requirement: Направление зависимостей
Разрешено: `core → orchestration → execution → tools → integrations`, `orchestration →
verification`, `agents → execution`, `delivery → integrations`, `autonomy → storage`,
`bot-link → integrations`, все домены → `config`. `orchestration` НЕ ДОЛЖЕН импортировать
Telegram, HTTP, GitHub и `core/bot.mjs`. Обратные зависимости запрещены.

#### Scenario: Новая стадия
- GIVEN нужна проверка или исправление
- WHEN выбирается место правила
- THEN оно живёт в `orchestration`, а не в `core/bot.mjs` или `integrations`.
