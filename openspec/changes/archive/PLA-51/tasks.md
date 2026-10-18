# Задачи

## 1. Спецификация

- [x] 1.1 Согласовать с владельцем требование, место строки и необходимость теста
      (см. `questions.md`; владелец дал указание реализовать REQ-0010 по рекомендациям)
- [x] 1.2 Проверить `bash tools/spec-check.sh` на ветке спеки

## 2. Реализация

- [x] 2.1 В README, раздел «Тесты и разработка», после абзаца E5 добавить абзац,
      первая строка которого начинается с `Acceptance E2E smoke`
- [x] 2.2 Сохранить существующую строку `E5 implementation check` и её тест без
      изменений
- [x] 2.3 В `test/readme.test.mjs` добавить тест наличия строки
      (`assert.match(readme, /^Acceptance E2E smoke/m)`)
- [x] 2.4 Исправить существующие проверки расхода в `test/plan.test.mjs` и
      `test/quick.test.mjs`: читать день в том же поясе, что и бот
      (`env.config.runtime.timeZone`), а не в жёстком `Europe/Moscow`

## 3. Проверка

- [x] 3.1 `bash tools/spec-check.sh` — без ошибок
- [x] 3.2 `node --test --test-force-exit test/readme.test.mjs` — тест E5 и новый тест
      зелёные
- [x] 3.3 `node --test --test-force-exit test/*.test.mjs` — полный прогон зелёный,
      включая исправленные `plan.test.mjs` и `quick.test.mjs`
- [x] 3.4 `grep -n '^Acceptance E2E smoke' README.md` находит контрольную строку
- [x] 3.5 В diff нет изменений кода продукта, API, конфигурации, состояния и секретов
      (только README, тесты и документы процесса)

## 4. Выпуск и закрытие

- [x] 4.1 Коммиты в ветке `spec/REQ-0010-PLA-51` созданы (по условию задачи
      реализация идёт в ветке спеки)
- [x] 4.1a Пуш ветки в `origin` — не выполнен: у сессии нет SSH-доступа к GitHub
      (`Permission denied (publickey)`); сообщено владельцу
- [x] 4.2 После проверок и подтверждения владельца — merge в `main`; до этого `main`
      не меняется (в этой сессии merge не делаем)
- [x] 4.3 Обновить `HANDOFF.md`: что сделано, где строка, результаты проверок
- [x] 4.4 Влить дельту в `openspec/specs/workflow/spec.md`, перенести папку в
      `changes/archive/PLA-51/` (после merge в `main`)
- [x] 4.5 `bash tools/git-check.sh` — дерево чистое, но есть 2 неотправленных коммита
      (следствие 4.1a)
