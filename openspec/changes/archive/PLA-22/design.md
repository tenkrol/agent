# Техническое решение

```text
src/orchestration/lifecycle-manager.mjs
  createTaskLifecycle({ journal, stateStore, now })
    queue / running            — очередь и текущая попытка
    enqueue/shift/clearQueue   — порядок и отмена очереди
    recover({...})             — восстановление из журнала и awaiting
    awaitingFor/set/clear      — вопросы; состояние в stateStore как раньше
    close/update/transition    — терминальные переходы через журнал
    drain({runTask,onError})   — единый цикл очереди
```
`AgentBot`:
- `queue`/`running` — геттеры/сеттеры к `this.lifecycle`, без второго массива;
- `drain` делегирует `lifecycle.drain`;
- `recoverTasks` делегирует `lifecycle.recover` (снимок файлов и действия — порты);
- awaiting-методы делегируют lifecycle;
- завершение задач (`journal.close`) — через `lifecycle.close`;
- быстрый fallback и DSH уже используют общий `orchestrator.run`.

Порты не меняют формат JSONL: те же записи, те же переходы, тот же state.json для
awaiting. Терминальный статус пишется только lifecycle; `AgentBot` не вызывает
`journal.close` напрямую.

## Совместимость
Команды `/tasks`, `/task`, `/cancel`, `/retry`, `/continue`, `/status` читают те же
журнал/состояние; поведение порядка очереди и восстановления не меняется. Откат —
предыдущий релиз/ветка, формат данных прежний.
