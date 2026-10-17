# Техническое решение

## Как устроено сейчас
`src/config.mjs` экспортирует `loadConfig(env)`, `ConfigError` и `secretsOf(config)`.
Внутри — таблица значений по умолчанию (`DEFAULTS`), набор валидаторов (`choice`,
`positiveInt`, `nonNegativeNumber`, `absolutePath`, `parseUserIds`, `clockMinutes`) и одна
большая функция, собирающая объект по секциям (`telegram`, `dsh`, `limits`, `alerts`,
`report`, `disk`, `schedules`, `bridge`, `voice`, `pricing`, …).

## Предлагаемое решение
```
src/config/
  index.mjs     публичный API: loadConfig, ConfigError, secretsOf
  env.mjs       чтение process.env и значения по умолчанию
  values.mjs    валидаторы (choice, positiveInt, clockMinutes, …)
  sections.mjs  сборка секций конфига
src/config.mjs  тонкая совместимость: export * from './config/index.mjs'
```
- Публичный API не меняется: `loadConfig(process.env)` возвращает тот же объект.
- `src/config.mjs` остаётся как однострочный реэкспорт, чтобы не ломать внешние вызовы
  и тесты; удаляется на шаге `slim-core`.
- Импорты внутри `src/` переключаются на `./config/index.mjs` механически.
- Сторожевой тест: в файлах вне `src/config/` нет `process.env` (кроме тестов и
  `src/index.mjs`, где окружение передаётся в `loadConfig`).

## Влияние
- Механический дифф по ~30 файлам (только строка импорта), поведение не меняется.
- Риск: забытая замена импорта — ловится полным прогоном тестов и стартом сервиса.
- Откат: переключить `/opt/agent` на предыдущий релиз.

## Альтернативы
- Оставить `config.mjs` монолитом и только добавить сторожевой тест — дешевле, но не
  решает задачу границ: валидаторы остаются недоступны по отдельности.
- Разбить на пакеты с DI — избыточно для одного процесса без зависимостей.
