# Исправления по ревью 18.10.2026

Ссылка на поручение: `dsh-implementation-review-and-fixes.md`.

## F1 — поручения vs заявки — исправлено

- PLB-028 (assistant, commit `18da6aa`): классификатор data/product/ambiguous.
- Напоминания/календарь/память не вызывают createRequest; product создаёт заявку или
  уточняет; проверка идёт после ответа агента на открытый вопрос.
- Тесты через реальный `handleMessage`; полный прогон бота 988.
- Деплой: **не установлен** — на сервере падают два чужих теста (`acceptance.test.mjs`,
  статистика на границе суток); в дереве идёт незакоммиченная PLB-026. Код закоммичен.

## F2 — согласованная ревизия — исправлено

- PLA-39: lifecycle draft→approved→ready→running→verified→release_pending→released;
  approval = revision + approvedBy/At + точные SHA.
- implement проверяет approval/SHA, checkout точного specificationCommit, пишет
  running/verified/failed; повтор без retry запрещён.
- `/v1/approve`.
- Тесты: `request-state.test.mjs`, `implement.test.mjs`.

## F3 — проверенный merge — исправлено

- PLA-40: deploy читает verified-статус, implementationCommit; merge с актуальным main,
  проверки результата; публикуется только проверенный merged SHA; чужая ветка отклоняется.
- Тест на реальном временном Git (`deploy-local-git.test.mjs`).

## F4 — профили — ограничение зафиксировано

- PLA-41: profileStatus=unsupported для files/monitor/personal; model_usage содержит
  role/provider/model. DSH-headless не поддерживает переключение, поэтому профили не
  выдаются за действующие. Это соответствует ветке «явно ограничить конфигурацию».

## G1 — почасовой подбор — реализовано

- PLA-42: poller `req/*` без LLM, status next/error/found; ready-заявки ставятся в
  существующую очередь kind=implement; идемпотентность `implement:<REQ>:r<rev>`;
  отмена/lease прокидываются в signal; `/v1/poll`, `/v1/poll/status`.
- Production release `211805`: `/v1/poll/status` отвечает, nextPollAt установлен.

## G2 — ready-спецификация — реализовано

- PLA-44: `/v1/specify` запускает DSH-исследование в spec-ветке, требует spec-check,
  пишет status ready; approve разрешён только после ready.

## G3 — установка/откат — реализовано

- PLA-43: install healthcheck; при неудаче/исключении rollback, rolled_back/ok=false;
  merge/checked/published/installed разделены. Ручной режим — installation_required.

## Осталось

- Деплой F1 после приведения тестов бота в зелёное состояние и завершения PLB-026.
- Сквозная приёмка с реальной ready-заявкой: specify→approve→poll→implement→deploy.
- Раздел 3 поручения (автономный личный помощник) — отдельные изменения, не начат.
