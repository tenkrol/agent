#!/usr/bin/env bash
#
# Этап 0 «Наблюдатель»: сбор метрик хоста без участия модели.
#
# Один запуск — одна строка в журнале наблюдений. Стоимость: ноль токенов.
# Запускается таймером agent-metrics.timer каждые 5 минут от имени пользователя
# agent, поэтому пишет только в своё состояние.
#
#   systemctl list-timers agent-metrics.timer
#   bash /opt/agent/deploy/metrics-collect.sh          # снять замер вручную
#   tail -1 /var/lib/agent/state/observations.jsonl    # последняя строка
#
# В журнал попадает: диск (% и свободные МБ), память, load average, аптайм,
# статус сервиса агента, число его перезапусков и счётчик ошибок в журнале за
# интервал. Ротация — здесь же (этап 0 требует её с самого начала: «свои же
# журналы начинают занимать диск»).
set -euo pipefail

STATE_DIR=${STATE_DIR:-/var/lib/agent/state}
JOURNAL=${JOURNAL:-$STATE_DIR/observations.jsonl}
SERVICE=${SERVICE:-dsh-agent}
RETAIN_DAYS=${OBSERVE_RETAIN_DAYS:-30}
MOUNT=${OBSERVE_MOUNT:-/}
# Ошибки читаются из journald, если пользователю это разрешено; иначе поля нет.
ERROR_WINDOW_MIN=${OBSERVE_ERROR_WINDOW_MIN:-6}

mkdir -p "$STATE_DIR"

now_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
now_epoch=$(date -u +%s)

# ── диск ─────────────────────────────────────────────────────────────────────
disk_line=$(df -P "$MOUNT" | tail -1)
disk_total_kb=$(printf '%s' "$disk_line" | awk '{print $2}')
disk_used_kb=$(printf '%s' "$disk_line" | awk '{print $3}')
disk_free_kb=$(printf '%s' "$disk_line" | awk '{print $4}')
disk_pct=$(printf '%s' "$disk_line" | awk '{gsub("%", "", $5); print $5}')

# ── память ───────────────────────────────────────────────────────────────────
mem_total_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
mem_available_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
mem_used_kb=$((mem_total_kb - mem_available_kb))
mem_pct=$((mem_total_kb > 0 ? mem_used_kb * 100 / mem_total_kb : 0))

# ── нагрузка, аптайм, перезапуски ────────────────────────────────────────────
read -r load1 load5 load15 _ < /proc/loadavg
uptime_sec=$(awk '{printf "%d", $1}' /proc/uptime)
cpu_count=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)
service_state=$(systemctl is-active "$SERVICE" 2>/dev/null || true)
service_failed=$(systemctl is-failed "$SERVICE" 2>/dev/null || true)
restarts=$(systemctl show -p NRestarts --value "$SERVICE" 2>/dev/null || echo "")

# ── ошибки сервиса за интервал (если journald доступен) ──────────────────────
errors=""
if journalctl -u "$SERVICE" --since "-${ERROR_WINDOW_MIN}min" -p err --no-pager -q >/tmp/metrics-errors.$$ 2>/dev/null; then
  errors=$(grep -c . /tmp/metrics-errors.$$ || true)
fi
rm -f /tmp/metrics-errors.$$

python3 - "$JOURNAL" "$now_iso" "$now_epoch" \
  "$disk_total_kb" "$disk_used_kb" "$disk_free_kb" "$disk_pct" \
  "$mem_total_kb" "$mem_used_kb" "$mem_available_kb" "$mem_pct" \
  "$load1" "$load5" "$load15" "$cpu_count" "$uptime_sec" \
  "$service_state" "$service_failed" "${restarts:-}" "${errors:-}" <<'PY'
import json, os, sys, tempfile

(journal, iso, epoch, dtotal, dused, dfree, dpct,
 mtotal, mused, mavail, mpct, l1, l5, l15, cpus, uptime,
 state, failed, restarts, errors) = sys.argv[1:21]

sample = {
    'ts': iso,
    'epoch': int(epoch),
    'disk': {'totalKb': int(dtotal), 'usedKb': int(dused), 'freeKb': int(dfree), 'usedPct': int(dpct), 'mount': '/'},
    'mem': {'totalKb': int(mtotal), 'usedKb': int(mused), 'availableKb': int(mavail), 'usedPct': int(mpct)},
    'load': {'one': float(l1), 'five': float(l5), 'fifteen': float(l15), 'cpuCount': int(cpus)},
    'uptimeSec': int(uptime),
    'service': {'name': 'dsh-agent', 'state': state, 'failed': failed == 'failed'},
}
if restarts != '':
    sample['service']['restarts'] = int(restarts)
if errors != '':
    sample['service']['errors'] = int(errors)

# append-only: строка целиком, запись атомарная
line = json.dumps(sample, ensure_ascii=False, separators=(',', ':'))
with open(journal, 'a', encoding='utf-8') as handle:
    handle.write(line + '\n')

# ротация: держим не дольше RETAIN_DAYS суток (по умолчанию 30)
retain_days = int(os.environ.get('OBSERVE_RETAIN_DAYS', '30'))
cutoff_epoch = int(epoch) - retain_days * 86400
kept = []
trimmed = 0
with open(journal, encoding='utf-8') as handle:
    for row in handle:
        row = row.strip()
        if not row:
            continue
        try:
            if json.loads(row).get('epoch', 0) >= cutoff_epoch:
                kept.append(row)
            else:
                trimmed += 1
        except Exception:
            kept.append(row)
if trimmed:
    directory = os.path.dirname(journal) or '.'
    fd, temp = tempfile.mkstemp(dir=directory, prefix='.observations-')
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(kept) + '\n')
    os.replace(temp, journal)
    print(f'rotated: removed {trimmed} old samples, kept {len(kept)}')

print(f"sample {iso}: disk {dpct}% ({int(dfree)//1024} MB free), mem {mpct}%, load {l1}/{l5}/{l15}, service {state}")
PY
