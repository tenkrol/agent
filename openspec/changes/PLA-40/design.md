# Решение

`mergeSha` вливает конкретный commit, `runCodeChecks` проверяет integration checkout,
`push` вызывается после проверок. `publishedSha===checkedSha`. Отчёт отдельно
показывает implementationCommit, mergedSha, checkedSha, installed.state.
