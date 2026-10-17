# Контракт ассистент ↔ агент, версия 2 (черновик)

Статус: проект в изменении PLA-14. После архивации становится
`openspec/specs/bot-link/contract.md` и источником истины для обеих сторон.

Транспорт: HTTP по loopback через SSH-туннель; авторизация — `Authorization: Bearer <token>`.
Тела — JSON UTF-8, ответы — JSON. Входящий приём — не больше 64 КиБ, текст задачи — не
больше `BRIDGE_MAX_TASK_CHARS`.

## 1. Постановка задачи
`POST /v1/tasks`

```json
{
  "contract": 2,
  "requestId": "uuid или стабильный ключ запроса",
  "task": "полная формулировка поручения",
  "source": "assistant",
  "revisionOf": "необязательный id прошлой задачи",
  "route": {
    "platform": "telegram",
    "botId": "8414623999",
    "chatId": "433296567",
    "threadId": null,
    "messageId": 12345
  },
  "attachments": [
    { "kind": "document", "name": "план.docx", "mime": "...", "size": 1234,
      "ref": "assistant://files/<id>" }
  ],
  "context": { "facts": ["факты, отобранные ассистентом для этой задачи"] }
}
```

Ответ `202`:

```json
{ "ok": true, "contract": 2, "taskId": "101034-1a", "state": "queued", "duplicate": false }
```

Ошибки: `400` (нет задачи/кривой JSON), `401` (токен), `409` (тот же `requestId` с другим
телом), `413` (тело), `503` (не сохранено — задача не принята).

`route` — куда возвращать вопрос и результат. Без `route` задача считается личной задачей
владельца в чате агента. `revisionOf` создаёт новую версию результата, сохраняя связь.

## 2. Состояние задачи
`GET /v1/tasks/:id`

```json
{
  "ok": true,
  "contract": 2,
  "task": {
    "id": "101034-1a",
    "execution": "running",
    "delivery": { "state": "pending", "attempts": 0 },
    "question": null,
    "result": null,
    "version": 1,
    "rootTaskId": "101034-1a",
    "revisionOf": null,
    "updatedAt": 1760000000000
  }
}
```

Когда задача ждёт ответа: `execution: "awaiting_owner"`, `question` содержит текст и
варианты. Когда результат готов: `result` содержит краткий текст и список файлов.
`delivery` отражает только доставку и не подменяет состояние выполнения.

## 3. Ответ на вопрос
`POST /v1/tasks/:id/reply`

```json
{ "contract": 2, "requestId": "reply-1", "text": "вариант 2", "variant": 2 }
```

Ответ `202`; задача продолжается с сохранённой сессией. Повтор с тем же `requestId`
возвращает прежний результат без второго запуска.

## 4. Отмена
`POST /v1/tasks/:id/cancel` — `{ "contract": 2, "requestId": "cancel-1" }`.
Ответ `200`; задача в состоянии `cancelled`, выполнение останавливается. Отмена
идемпотентна.

## 5. Ревизия результата
`POST /v1/tasks` с `revisionOf` — новая задача с `rootTaskId` прежней, `version` на единицу
больше. Агент использует прошлый результат и файлы как входные материалы. Прежняя версия
остаётся доступной (`GET /v1/tasks/:oldId`) согласно сроку хранения.

## 6. События доставки (агент → ассистент)
`POST <OUTBOX_URL>` — тот же адрес, что и раньше.

```json
{
  "contract": 2,
  "eventId": "<taskId>:result:1",
  "taskId": "101034-1a",
  "type": "result",
  "route": { "platform": "telegram", "botId": "...", "chatId": "...", "messageId": 12345 },
  "createdAt": 1760000000000,
  "attempt": 1,
  "text": "текст для доставки (обязателен: так работают старые приёмники)",
  "title": "Ответ агента",
  "files": [ { "name": "отчёт.docx", "size": 2048, "mime": "...", "caption": "..." } ],
  "question": { "text": "...", "variants": [ { "n": 1, "text": "..." } ] }
}
```

Типы: `result`, `question`, `cancelled`, `state` (редкие служебные смены, без дублирования
результата).

Ответ ассистента `200`:

```json
{ "ok": true, "eventId": "<тот же>", "processed": true, "duplicate": false }
```

`processed: true` — подтверждение обработки (`ack`), после него агент событие больше не
отправляет. Если ассистент уже обработал `eventId`, он возвращает `processed: true` и
`duplicate: true`. Ошибка `5xx` или сеть — повтор с тем же `eventId` по расписанию
`DELIVERY_RETRY_MS`, не больше `DELIVERY_MAX_ATTEMPTS`.

Старый приёмник без `ack` получает `200` и не подтверждает обработку: агент фиксирует
`sent` и не считает доставку подтверждённой. Это осознанная деградация совместимости.

## 7. Возможности и версия
`GET /v1/health` — `{ ok: true, service: "agent-bridge", contract: 2 }`.
`GET /v1/capabilities` — `{ contract: 2, tasks: true, reply: true, cancel: true, revision: true,
events: true }`. Сторона, которая видит `contract: 2`, пользуется новыми полями; иначе
работает прежний `/bridge`.

## 8. Границы доверия
- Контракт не расширяет права агента: подлинность запроса ассистента не разрешает
  произвольные действия, агент проверяет операцию по своей политике.
- `route` принимается только для настроенного ассистента; чужие `chatId`/`botId`
  отклоняются.
- `attachments[].ref` — только разрешённые схемы (`assistant://`); произвольные URL и пути
  не принимаются.
- Секреты в поля контракта не попадают.
