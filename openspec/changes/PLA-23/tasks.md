# Задачи

## 1. Очередь
- [x] 1.1 Транзакционный requeue с payload/generation/идемпотентностью
- [x] 1.2 complete/setStatus/heartbeat: owner+status+lease, без повторного terminal
- [x] 1.3 owns/cancelAll/listPending/nextLeaseAt

## 2. Lifecycle
- [x] 2.1 retry через requeue, clearQueue через cancelAll
- [x] 2.2 fence heartbeat/stale, не писать терминал
- [x] 2.3 Восстановление до TTL без новых задач
- [x] 2.4 workers>1 программно отклоняется

## 3. AgentBot
- [x] 3.1 leaseSignal и owns перед завершением/доставкой
- [x] 3.2 drain при SQLite pending/running без memory queue

## 4. Тесты
- [x] 4.1 requeue awaiting/done + payload
- [x] 4.2 clearQueue отменяет SQLite queued
- [x] 4.3 stale complete/negative heartbeat
- [x] 4.4 crash/restart до TTL
- [x] 4.5 workers>1 отказ
- [x] 4.6 Полный прогон

## 5. Публикация
- [x] 5.1 Ветка, commit/push, SHA (без merge/деплоя)
