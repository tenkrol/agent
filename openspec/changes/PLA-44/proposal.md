# PLA-44 / G2: draft → ready-спецификация

Основание: review G2. E4 генерировал каркас с незаполненными решениями и общими
критериями; approval мог состояться сразу над черновиком.

## Что меняется
- `workflow/specify`: DSH исследует затронутый код в spec-ветке компонента и
  заполняет proposal/design/tasks/spec, критерии и questions.md.
- После успешного spec-check заявка получает status ready с новыми SHA спек.
- `/v1/approve` разрешён только после ready; approval фиксирует точные SHA.
- `/v1/specify` идёт через тот же runner, но не меняет код продукта.
