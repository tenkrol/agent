# Решение

`createDshExecutor` принимает `profileStatus` (по умолчанию unsupported) и отдаёт его
в describe(). Бот передаёт его для files/monitor/personal. В событие model_usage
добавляются provider/model/role/attemptId. Переключение модели не имитируется.
