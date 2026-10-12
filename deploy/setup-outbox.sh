#!/usr/bin/env bash
#
# Настройка связи «агент → бот»: одна команда вместо ручных шагов.
#
#   sudo bash deploy/setup-outbox.sh
#
# Что делает (идемпотентно, можно запускать сколько угодно раз):
#   1. забирает с бота токен точки приёма и кладёт его в /etc/tg-agent/outbox-token;
#   2. выдаёт права root:agent, 640 — иначе агент, работающий под пользователем
#      agent, токен не прочитает, и отчёты молча не пойдут;
#   3. публикует токен в окружение сервиса через drop-in (EnvironmentFile), чтобы
#      агенту не приходилось читать файл: его песочница в /etc не пускает;
#   4. ставит отправитель agent-notify и его копию в рабочей папке агента;
#   5. ставит сторож завершённых задач (читает журнал dsh-agent и отчитывается);
#   6. проверяет всё живой отправкой от имени agent и падает, если не ушло.
set -euo pipefail

TOKEN_FILE=${TOKEN_FILE:-/etc/tg-agent/outbox-token}
ENV_FILE=${ENV_FILE:-/etc/tg-agent/outbox.env}
AGENT_USER=${AGENT_USER:-agent}
AGENT_ENV=${AGENT_ENV:-/etc/agent/agent.env}
AGENT_WORKSPACE=${AGENT_WORKSPACE:-/var/lib/agent/workspace}
NOTIFY=${NOTIFY:-/usr/local/bin/agent-notify}
WATCH=${WATCH:-/usr/local/bin/agent-run-watch}
DROPIN_DIR=/etc/systemd/system/dsh-agent.service.d
BOT_HOST=${BOT_HOST:-root@185.174.136.53}
BOT_KEY=${BOT_KEY:-/etc/tg-agent/monitor_key}
BOT_ENV=${BOT_ENV:-/opt/tg-agent/.env}
HERE=$(cd "$(dirname "$0")" && pwd)

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*"; }
[ "$(id -u)" = "0" ] || { echo "нужен root" >&2; exit 1; }

install -d -m 0755 /etc/tg-agent

# 1. Токен: своего нет — берём с бота по ключу мониторинга.
if [ ! -s "$TOKEN_FILE" ]; then
  log "беру токен с бота ($BOT_HOST)"
  ssh -i "$BOT_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
      -o UserKnownHostsFile=/root/.ssh/known_hosts "$BOT_HOST" \
      "grep '^OUTBOX_TOKEN=' $BOT_ENV" > "$TOKEN_FILE" || {
    echo "не удалось получить токен: проверьте ключ $BOT_KEY и OUTBOX_TOKEN в $BOT_ENV" >&2; exit 1; }
fi
[ -s "$TOKEN_FILE" ] || { echo "файл токена пуст: $TOKEN_FILE" >&2; exit 1; }

# 2. Права: 600 root ломало отчёты, потому что агент работает под пользователем agent.
chown root:"$AGENT_USER" "$TOKEN_FILE"
chmod 640 "$TOKEN_FILE"
log "токен: $(stat -c '%a %U:%G' "$TOKEN_FILE")"

# 3. Токен в окружение сервиса — песочница агента в /etc не пускает.
grep "^OUTBOX_TOKEN=" "$TOKEN_FILE" > "$ENV_FILE"
chown root:"$AGENT_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"
install -d -m 0755 "$DROPIN_DIR"
cat > "$DROPIN_DIR/outbox.conf" <<UNIT
[Service]
EnvironmentFile=$ENV_FILE
UNIT
log "окружение сервиса: $ENV_FILE (drop-in $DROPIN_DIR/outbox.conf)"

# 4. Отправитель: системный и копия в рабочей папке агента.
install -m 0755 "$HERE/agent-notify" "$NOTIFY"
install -d -m 0755 "$AGENT_WORKSPACE"
install -m 0755 "$HERE/agent-notify" "$AGENT_WORKSPACE/agent-notify"
chown "$AGENT_USER":"$AGENT_USER" "$AGENT_WORKSPACE/agent-notify"
log "отправитель: $NOTIFY и $AGENT_WORKSPACE/agent-notify"

# 5. Сторож завершённых задач: агент сам отчитаться не может — его песочница
#    не даёт запускать команды, а журнал о завершении пишет бинарник dsh.
install -m 0755 "$HERE/agent-run-watch" "$WATCH"
cat > /etc/systemd/system/agent-run-watch.service <<'UNIT'
[Unit]
Description=Отчёт владельцу о завершённых задачах агента

[Service]
Type=oneshot
ExecStart=/usr/local/bin/agent-run-watch
UNIT
cat > /etc/systemd/system/agent-run-watch.timer <<'UNIT'
[Unit]
Description=Проверять завершённые задачи агента каждую минуту

[Timer]
OnCalendar=*:*:00
AccuracySec=10s
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now agent-run-watch.timer >/dev/null 2>&1
log "сторож: $(systemctl is-active agent-run-watch.timer) / $(systemctl is-enabled agent-run-watch.timer 2>/dev/null)"

# туннель до точки приёма бота
if systemctl cat tg-outbox-tunnel.service >/dev/null 2>&1; then
  systemctl is-enabled --quiet tg-outbox-tunnel.service || systemctl enable tg-outbox-tunnel.service >/dev/null 2>&1
  systemctl is-active --quiet tg-outbox-tunnel.service || systemctl restart tg-outbox-tunnel.service
  log "туннель: $(systemctl is-active tg-outbox-tunnel.service)"
else
  log "нет юнита tg-outbox-tunnel.service — связь не поднимется, установите его"
fi

systemctl restart dsh-agent
log "агент перезапущен: $(systemctl is-active dsh-agent)"

# 6. Проверка от имени самого агента — так, как это будет в бою.
if ! runuser -u "$AGENT_USER" -- test -r "$TOKEN_FILE" && ! runuser -u "$AGENT_USER" -- env OUTBOX_TOKEN=1 true; then
  echo "пользователь $AGENT_USER не получит токен — отчёты не пойдут" >&2; exit 1
fi
if [ "${SKIP_TEST:-0}" != "1" ]; then
  if runuser -u "$AGENT_USER" -- "$AGENT_WORKSPACE/agent-notify" --title "Проверка связи" \
       "Установка связи агент → бот завершена: отчёты и ответы будут приходить в чат." >/dev/null 2>&1; then
    log "проверочное сообщение отправлено — оно должно прийти владельцу"
  else
    log "проверочное сообщение НЕ ушло: смотрите systemctl status tg-outbox-tunnel и журнал бота"
  fi
fi
log "готово"
