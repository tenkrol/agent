# PLA-23: корректность SQLite-очереди и fencing (workers=1 безопасно)

Основание: ревью production `de148e3`. SQLite включён, но workers=1 всё ещё
воспроизводит потерю задач/статусов. Отдельное исправление, без новых миграций и
деплоя до проверки.

## Зачем
1. `lifecycle.retry` → `enqueue` с `INSERT OR IGNORE`: awaiting/done задача не
   возвращается в queued и не обновляет payload; после claim → setStatus awaiting →
   retry → claim = undefined, задача теряется.
2. `clearQueue` отменяет только JSONL/массив; SQLite queued остаётся и выдаётся claim.
3. `complete` проверяет только generation: после `recoverExpired` старая попытка может
   завершить задачу; possible double terminal; fencing до побочных эффектов отсутствует.
4. Crash/restart до TTL: running-аренда не восстановлена, drain не запускается без новых
   задач; после TTL задача зависает.
5. workers>1 без изоляции workspace/runner/progress должен программно отклоняться.

## Что меняется
- `SqliteTaskQueue`: транзакционный `requeue` с обновлением payload/generation,
  инвалидацией старой попытки и идемпотентностью; `cancelAll`, `owns`, `nextLeaseAt`,
  `listPending`; `complete`/`setStatus`/`heartbeat` проверяют owner/status/lease.
- `lifecycle`: retry через requeue, clearQueue через cancelAll; drain проверяет аренду,
  heartbeat-fail прерывает попытку, stale не пишет терминал; восстановление
  возобновляет ожидание истечения аренды без новых задач; workers>1 — отказ.
- `config`: `QUEUE_WORKERS>1` — явная ошибка до старта.

## Не входит
Новые миграции, merge/deploy, параллельные workers, SQLite schema v2. Production
остаётся на текущем SQLite, workers=1.
