# Решение

`monitor` — тот же DSH-runner с id monitor, taskPrefix (читать deploy/agent-metrics,
/observe, alert-скрипты; не менять систему) и modelProfile agentProfiles.monitor.
Селектор: monitor → files → dsh, явный executorId сохраняется.
