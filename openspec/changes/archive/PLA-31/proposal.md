# PLA-31 / E5: разработчик по заявке в изолированном checkout

Основание: план E5. E4 публикует компонентные спеки и manifest с changeId/SHA.

## Что меняется
- `workflow/implement`: загружает заявку с ветки `req/<REQ>`, клонирует компонент
  на ветку `spec/<REQ>-<changeId>`, запускает DSH в этом каталоге, коммитит и пушит
  ветку `impl/<REQ>-<changeId>`.
- `POST /v1/implement` с bearer-токеном; возвращает ветки/SHA/compare URL.
- В main и production код не попадает: только ветки реализации.

## Не входит
Создание PR через API (deploy key), verification/repair (E6), deploy (E7).
