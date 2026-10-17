# Правила проекта — в AGENTS.md

Единственный источник правил — [AGENTS.md](AGENTS.md); он же обязателен для любой сессии и
любого инструмента. Кратко, чтобы не терять контекст:

- работа идёт по OpenSpec: `openspec/README.md` (ритуал), `openspec/conventions.md`
  (конвенции), спеки доменов в `openspec/specs/`;
- код меняется только в папке изменения `openspec/changes/PLA-<номер>/` — сначала спека и
  одобрение владельца, потом код;
- номер сквозной: новый = последний в `openspec/changes/archive/` + 1 (на 2026-10-17
  следующий свободный — `PLA-13`);
- перед деплоем — `node --test --test-force-exit test/*.test.mjs` и
  `bash tools/spec-check.sh`;
- деплой — только `bash deploy/install-remote.sh`;
- секреты — только в шифртексте `secrets/agent.env.enc`, пароль вне репозитория.
