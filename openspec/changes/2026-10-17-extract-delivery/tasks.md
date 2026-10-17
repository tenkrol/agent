# Задачи

## 1. Спецификация
- [x] 1.1 Дельта-спека согласована (2026-10-17, в рамках одобрения очереди)

## 2. Реализация
- [x] 2.1 `src/delivery/report.mjs`: buildHeader, composeReportText, statusMarkdown + quickFooter/quickStatus
- [x] 2.2 `src/delivery/index.mjs` — публичный API
- [x] 2.3 `bot.mjs`: reportResult и быстрый ответ собираются через домен
- [x] 2.4 Сторожевой тест: без внешних импортов в delivery

## 3. Тесты
- [x] 3.1 Тесты домена: заголовки, обрезка, подпись, дорогая задача, заметки, статусы
- [x] 3.2 Полный прогон: 319 тестов зелёные

## 4. Деплой и проверка
- [ ] 4.1 `deploy/install-remote.sh`, сервис active, задача через мост

## 5. Закрытие
- [ ] 5.1 Дельта влита в `openspec/specs/delivery/spec.md`
- [ ] 5.2 `HANDOFF.md` обновлён, изменение заархивировано
