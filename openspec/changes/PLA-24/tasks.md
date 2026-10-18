# Задачи

## E0-A
- [x] A1 leaseSignal связан с attemptController до всех стадий
- [x] A2 потеря аренды не пишет cancelled/failed и не публикует результат
- [x] A3 тест с реальным DSH-адаптером: signal.aborted
- [ ] A4 независимая проверка wiring на production-портах

## E0-B
- [x] B1 граница acceptResult: owns + фиксация результата/outbox
- [x] B2 доставка читает accepted outbox, повтор не пересчитывает
- [x] B3 onError учитывает актуальность попытки
- [ ] B4 быстрый ответ/план/вопрос/ошибка/файлы/память покрыты
- [ ] B5 тест гонки owns/await и stale публикации

## E0-C
- [x] C1 сверка терминального SQLite-результата со stale JSONL при recovery
- [ ] C1b полная матрица crash-точек SQLite/JSONL
- [ ] C2 откат на данных после бэкапа
- [ ] C3 тесты бюджета/отмены quick→план→DSH→проверка→исправление

## Публикация
- [ ] P1 полный прогон, commit/push SHA (без merge/деплоя до проверки)
