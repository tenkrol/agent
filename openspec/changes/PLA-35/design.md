# Решение

`createDshExecutor` параметризуется `id`, `capabilities`, `taskPrefix`, `modelProfile`.
В боте регистрируются `dsh` и `files` на одном runner, но `files` получает
инструкции про документы/артефакты и профиль `agentProfiles.files`.
`createOrchestrator` принимает `selectExecutor({job,task})`; выбранный id
используется и для repair, и возвращается в результате.
