# Техническое решение

## ADR: хранилище очереди
Контекст: ноль npm-зависимостей, Node 22 на сервере, текущий журнал — JSONL с одним
писателем. Проверка: `node -v` → v22.23.3, `require('node:sqlite')` → доступен
(ExperimentalWarning). Решение: использовать встроенный `node:sqlite` через
`DatabaseSync` в WAL-режиме для новой очереди, с флагом `QUEUE_STORE=jsonl|sqlite`.
Последствия: нужен Node 22.5+; experimental API может измениться; миграция и откат
обязательны. Альтернатива (JSONL + файловая блокировка) отвергнута для нескольких
писателей: сложно доказать атомарность захвата и защиту от устаревших результатов.

## Схема
```sql
tasks(id TEXT PRIMARY KEY, request_key TEXT UNIQUE, status TEXT NOT NULL,
      payload TEXT, lease_owner TEXT, lease_until INTEGER, generation INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
attempts(task_id TEXT NOT NULL, generation INTEGER NOT NULL, owner TEXT NOT NULL,
         started_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, status TEXT,
         PRIMARY KEY(task_id, generation))
events(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, generation INTEGER,
       type TEXT NOT NULL, at INTEGER NOT NULL, data TEXT)
```
`status`: `queued/running/verifying/awaiting_owner/done/partial/failed/cancelled/interrupted`.
Терминальные статусы не захватываются.

## Захват и завершение
- `enqueue` — `INSERT OR IGNORE` по `request_key`; существующая задача возвращается.
- `claim(owner, ttl)` — `BEGIN IMMEDIATE`; выбирается `queued` или `running` с истёкшей
  арендой; `generation += 1`, записывается аренда и попытка; COMMIT.
- `heartbeat(task, generation, ttl)` — продление только своей аренды.
- `complete(task, generation, status)` — только при совпадении `generation`; иначе
  `stale: true` и запись отвергается.
- `release` возвращает в `queued`; `recoverExpired` помечает потерянные попытки.
- Все переходы — в транзакции; событие пишется вместе с изменением.

## Миграция
1. Бэкап журнала и остановка записи.
2. Импорт задач в SQLite (`request_key` из журнала).
3. Двойное чтение/сверка количества и статусов.
4. Переключение флага, один писатель; старый журнал остаётся для отката.
5. Откат — флаг `QUEUE_STORE=jsonl` и прежний релиз.

## Влияние
Новые `src/storage/sqlite-queue.mjs` и тесты. Интеграция с ботом/оркестратором — отдельный
шаг этого же изменения после проверки примитивов. Пока production не переключается.
