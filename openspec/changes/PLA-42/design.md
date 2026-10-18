# Решение

Poller не пишет в репозитории и не запускает DSH напрямую: `onReady` вызывает
`enqueueImplementation`, которая создаёт job kind=implement. DSH выполняется
`executeImplementJob` внутри lifecycle: beginTask → implementer(signal) → done/failed.
Отмена и lease abort прокидываются в signal. Идемпотентность — requestKey журнала.
