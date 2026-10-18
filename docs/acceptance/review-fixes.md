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

## Раздел 3 — автономный помощник (в работе)

- **3.1 Модель дел** — PLB-029 (бот, `de3b31f`): WorkItem kinds goal/project/
  obligation/decision/question/result, epistemic fact/assumption/proposal, owner/scope,
  provenance, dates, history, staleAfter; JSON-хранилище; тесты.
- **3.2 Наблюдатели** — PLA-45 (`54c95cb`): реестр источников, GitHub HEAD и серверный
  probe, evidence/freshness/findings; unavailable явный; `/v1/observers`, `/v1/observe`.
- **3.3 /review** — PLA-46 (`ea58921`): детерминированные 1–3 предложения с источником,
  почему сейчас, пользой, стоимостью и проверкой; `/v1/review`.
- Production release `212206`: agents/review/observe live; `/v1/review` отвечает.

Осталось: теневой режим, инициативы/дедуп/тихие часы, политики действий, оценка пользы,
и ручной `/review` в боте (сейчас API).

### 3.4–3.7 — реализовано в коде

- **3.4** PLA-47 (`bd66d9d`): shadow store — сбор предложений/решений/метрики без отправки.
- **3.5** PLA-48: initiatives — дневной лимит, дедуп, тихие часы, do/later/never.
- **3.6** PLA-49 (`0520b79`): action-policy — observe/prepare/execute/approval, allowlist,
  бюджет, общий выключатель и отмена; LLM не расширяет разрешения.
- **3.7** PLA-50: benefit — фактическое before/after, verdict improved/regressed/unchanged/
  no_data, evidence и кандидат в память; код проходит тот же конвейер.
- API: `/v1/shadow`, `/v1/initiatives`, `/v1/policy`, `/v1/benefit`; production
  release `212538` active.
- Бот: PLB-030 (`3458246`) — `/review` с источником/почему/пользой/стоимостью/проверкой;
  тесты 999.
- Деплой бота F1/PLB-030 всё ещё ждёт зелёных тестов (2 чужих теста падают на сервере).

## Сквозная приёмка REQ-0010 (18–19.10.2026)

Сценарий: сообщение → specify → approval → poll → implement → проверки → deploy →
ручная установка.

- Заявка: `REQ-0010`, ветка `req/REQ-0010`; компонент `PLA-51` (`tenkrol/agent`).
- Specify: DSH исследовал код, заполнил proposal/design/tasks/spec/questions;
  status ready; manifest обновлён на ready SHA (найден и исправлен дефект: approval
  ссылался на каркасный SHA).
- Approval: `approvedBy=owner`, revision 1, specificationCommit `7d08fe7…`.
- Poll: `/v1/poll` нашёл заявку и поставил реализацию в очередь (kind=implement).
- Implement: два DSH-прогона (основной и repair) в изолированных каталогах; ветка
  `impl/REQ-0010-PLA-51`, коммиты `f4d2a2e` (README/test) и `edf9752` (починка
  timezone-проверок plan/quick). Статус verified.
- Deploy: mergedSha = checkedSha = publishedSha = `94d51e3…`; проверки результата
  слияния зелёные; `installed.state=installation_required`.
- Ручная установка: release `release-20261018-215346`, сервис active; README содержит
  `Acceptance E2E smoke`.
- Итог: generated/tested/merged/installed/healthy разделены; автоматическая установка
  не заявлялась (политика владельца — вручную).
