# Приёмка плана 222 (E0–E11)

Дата: 18.10.2026. Проверка на production-серверах: агент `185.106.94.155`,
бот `185.174.136.53`.

| Этап | Проверка | Доказательство | Статус |
|---|---|---|---|
| E0 | потеря аренды, accept/park+outbox, SQLite↔JSONL | `test/e0-lease.test.mjs`, `test/lifecycle-sqlite.test.mjs`, `test/sqlite-queue.test.mjs`; release 080807; live 080447/080821 | passed |
| E1 | реестр, fresh session, retention, лимит | `test/agents-isolation.test.mjs`, `test/per-task-workspace.test.mjs`; release 081716 | passed |
| E2 | активность/usage/профили | `/v1/agents`, `/v1/activity`, `/v1/usage` live; `test/activity.test.mjs`; PLB-015 | passed |
| E3 | spec-репозиторий, манифесты, ветки | `tenkrol/assistant-work`: REQ-0001/0002/0008; deploy keys проверены; PR через API | partial: PR только compare-ссылка |
| E4 | заявка→компоненты→спеки | REQ-0008: PLA-30+PLB-025, оба spec-check; `analysis.json` | passed для `/request`; auto-разбор обычного сообщения не сделан |
| E5 | DSH в изолированном checkout | REQ-0009: `impl/REQ-0009-PLA-32` (DSH изменил README/test/OpenSpec) | passed |
| E6 | проверки/ремонт перед публикацией | на impl: 483 pass, spec-check ok; repair-тесты | passed |
| E7 | merge+установка после подтверждения | deploy REQ-0009 → merge `14837cb`, release `191138` active | passed: install выполняет владелец |
| E8 | файловый агент | XLSX live `192227-bkm` → done/passed; `test/files-agent.test.mjs` | passed |
| E9 | агент-наблюдатель | live `192527-ou` → done; routing tests | passed |
| E10 | персональный агент | live `193014-vzl` → done; memory context tests | passed |
| E11 | финальная приёмка | этот документ + тесты | partial: см. ограничения |

## Финальный прогон

- агент: `node --test --test-force-exit --test-concurrency=1` → 494 pass.
- бот: `node --test --test-force-exit` → 969 pass (на момент проверки).
- сервисы: `dsh-agent` active, `tg-agent` active.

## Ограничения

1. **PR через GitHub API** не создаются: deploy key умеет только clone/push.
   Нужен fine-grained token или GitHub App; сейчас compare URL.
2. **Автоматическое распознавание заявки из обычного сообщения** не сделано:
   используется явная команда `/request`; неоднозначность внутри заявки обрабатывается.
3. **Установка** после deploy-merge выполняется владельцем/root: процесс агента
   работает без passwordless sudo (решение владельца).
4. Компонентные спеки E4 — каркас (proposal/design/tasks/acceptance), а не глубокий
   инженерный разбор; перед реализацией их дополняет DSH/человек.
5. E7 первоначально падал из-за root-owned файлов в каталоге клона; исправлено
   ownership, но автоматической проверки на это нет.
