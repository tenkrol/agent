# Техническое решение

## Очередь
- `requeue({taskId, payload, requestKey, now})`: `BEGIN IMMEDIATE`; select; запрещена
  для `running` с живой арендой; для `queued` с тем же payload — duplicate; иначе
  status=queued, payload=new, lease=NULL, generation+=1, event `requeued`.
- `complete`: UPDATE ... WHERE id=? AND generation=? AND lease_owner=? AND status='running'
  AND lease_until>=now; повторный terminal запрещён; attempt status обновляется только
  при успехе.
- `heartbeat`/`setStatus`: те же условия owner/generation/status/lease.
- `owns({taskId,generation,owner})` — fencing-проверка перед побочными эффектами.
- `cancelAll({now})` — UPDATE queued→cancelled; `listPending`/`nextLeaseAt` для
  восстановления без новых запросов.

## Lifecycle
- `retry` → `queueStore.requeue` (или memory).
- `clearQueue` → `queueStore.cancelAll`, затем журнал.
- `drain`: claim; heartbeat в интервале; при неудачном heartbeat abort lease-signal;
  после runTask повторно `owns`; stale → не complete, лог; runTask получает
  `{ leaseSignal, owns }`.
- Нет работы, но есть running lease → ждать `nextLeaseAt` и повторить claim.
- `workers>1` → throw, пока нет изоляции workspace.

## AgentBot
- Принимает `leaseSignal`; связывает с attemptController; перед завершением/доставкой
  проверяет `owns`; stale не пишет терминал и не доставляет.
- `start` планирует drain также при SQLite pending/running без memory queue.

## Тесты
Интеграционные с реальным SqliteTaskQueue: requeue awaiting/done с payload; clearQueue;
stale complete после recoverExpired; heartbeat lost; восстановление до TTL; workers>1
отклоняется; полный прогон.
