Правила проекта — в `AGENTS.md` в корне репозитория (единственный источник). Работа идёт по
OpenSpec: спека и одобрение владельца до кода, папки изменений `openspec/changes/PLA-<номер>`
(номер сквозной, новый = последний в `openspec/changes/archive/` + 1), перед деплоем —
`node --test --test-force-exit test/*.test.mjs` и `bash tools/spec-check.sh`.
