# Решение

Deploy после публикации проверенного SHA вызывает install. Если `healthy!==true` или
install бросил — rollback (если настроен), состояние rolled_back, ok=false. Отчёт
содержит implementationCommit/mergedSha/checkedSha/publishedSha/installed.state.
