# Решение

`src/workflow/requests.mjs`:
- `requestTemplate({requestId,title,text,components})` — request/proposal/acceptance/manifest;
- `createRequestDraft({dir,...})` — проверяет manifest через `request-manifest`,
  пишет атомарно файлы; при невалидных компонентах бросает ошибку без записи.
Инструмент `tools/request-new` остаётся CLI-обёрткой.
