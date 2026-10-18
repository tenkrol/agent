# Решение

`createBridgeServer` принимает `release`; в `/health` и `/v1/health` добавляет
`release` только если значение задано. `src/index.mjs` читает basename симлинка
`/opt/agent` на старте через `fs.readlink` (ошибка игнорируется) и передаёт в bridge.
