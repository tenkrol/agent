# Техническое решение

- `src/storage/activity.mjs`: append-only JSONL, `record(event)`, `recent({limit,agent,taskId})`,
  обрезка до `ACTIVITY_MAX_ENTRIES`; поля: `at,type,taskId,agent,stage,status,tokens,usd,chatId,userId`.
- API в `bridge-http`: `GET /v1/agents` → `{ok, contract, agents:[...], running}`;
  `GET /v1/activity?limit=50&agent=&taskId=` → `{ok, events}`. Тот же bearer-токен.
- Индексация: `bot.activity` пишет queued/started/completed/delivered; `agent` =
  `dsh`/`quick`, stage из orchestrator.
- Профили: config `agentProfiles` (`MODEL_NAME`/`MODEL_API_KEY` по умолчанию),
  поля `orchestrator`, `dsh`, `quick`; пока только читаются и попадают в describe.
