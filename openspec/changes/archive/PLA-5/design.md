# Техническое решение

## Как устроено сейчас
`telegram.mjs` — низкоуровневый клиент Bot API (`TelegramClient`, `TelegramError`).
`platform.mjs` — порт отправки (`TelegramPlatform`, `createTelegramPlatform`, `numericId`):
правки статуса, документы, кнопки, голос. `yandex-disk.mjs` — архив файлов (REST и WebDAV,
`joinPath`, `formatDiskSize`). Ядро импортирует их напрямую из `src/`.

## Предлагаемое решение
```
src/integrations/
  telegram.mjs    клиент Bot API + TelegramError
  platform.mjs    порт отправки (использует telegram.mjs)
  yandex-disk.mjs порт архива (REST/WebDAV)
  index.mjs       публичный API домена
```
- Пути импорта внутри домена не меняются (`platform.mjs` → `./telegram.mjs`).
- Наружу домен отдаёт готовые адаптеры; домены верхнего уровня (`core`, `delivery`,
  `execution`) продолжают получать их через `src/index.mjs`.
- Сторожевой тест фиксирует, что сеть живёт только здесь (с явным списком исключений,
  который сокращается: `bot.mjs` — до `bot-link`, `bridge-http.mjs` — до `bot-link`).

## Влияние
- Механический перенос: три файла и строки импортов в `src/index.mjs`, `src/bot.mjs`,
  `test/yandex-disk.test.mjs`.
- Риск: забытый импорт — ловится прогоном 304 тестов и стартом сервиса.
- Откат: переключение симлинка на предыдущий релиз.

## Альтернативы
- Свести интеграции к одному файлу — хуже читается и смешивает Bot API и архив.
- Ввести формальные интерфейсы на TypeScript — вне правил проекта (ноль зависимостей).
