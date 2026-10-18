# Итоговая приёмка по dsh-implementation-review-and-fixes.md

Дата: 19.10.2026.

| Критерий раздела 5 | Статус | Доказательство |
|---|---|---|
| Обычные напоминания не создают заявки | код/тесты passed; production pending | PLB-028, 999 тестов бота; deploy ждёт зелёных тестов |
| Черновик и устаревшее согласование не запускают DSH | passed | `request-state.test.mjs`, `implement.test.mjs`; approval по SHA |
| Проверяется и выпускается один результат интеграции | passed | PLA-40, `deploy-local-git.test.mjs`, E2E `94d51e3` |
| Профили влияют на реальные вызовы | **partial** | DSH-headless не переключает модель; `profileStatus=unsupported`, usage честный |
| Почасовой подбор через устойчивую очередь | passed | PLA-42, E2E REQ-0010: poll→queue→implement |
| Повтор/отмена/сбой/восстановление без двойной публикации | passed | идемпотентность, retry failed, tests; E2E retry |
| Спецификация содержит критерии до ready | passed | REQ-0010: DSH-спека, questions.md, manifest на ready SHA |
| Ручные этапы показаны как ручные | passed | deploy возвращает installation_required; установка вручную |
| Отчёт различает generated/tested/merged/installed/healthy | passed | deploy response + `/v1/install` reportInstalled |
| Приёмка E0–E11 соответствует коду | обновлено | plan-222 + review-fixes |
| План автономного помощника выделен в изменения | passed | PLB-029, PLA-45…50, PLB-030 |

## Открытые ограничения

1. **F1/PLB-030 не установлены в production**: deploy-safe падает на двух чужих тестах
   (`acceptance.test.mjs` — exit code 2 вместо 1; статистика — граница суток).
2. **Профили моделей** остаются декларацией: DSH-headless не принимает model per call.
3. **Ручная установка REQ-0010** выполнена (`release-20261018-215346`), но pending
   install map не пережил перезапуск, поэтому `/v1/install` для неё уже недоступен.
4. Автоматическая установка не включалась: политика владельца — вручную.

## Вывод

Основной конвейер и автономный помощник реализованы и проверены; полное «всё зелёно»
не заявляется из-за трёх ограничений выше.
