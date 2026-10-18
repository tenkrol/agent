#!/usr/bin/env bash
# Создать профили DSH для специализированных ролей, если их ещё нет.
# Использование: DSH_HOME=/var/lib/agent/dsh bash deploy/dsh-profiles.sh
set -euo pipefail
DSH_HOME=${DSH_HOME:-/var/lib/agent/dsh}
BASE="$DSH_HOME/profiles/headless"
[ -d "$BASE" ] || { echo "нет $BASE — профили не созданы"; exit 0; }
for role in files monitor personal; do
  DIR="$DSH_HOME/profiles/$role"
  if [ ! -d "$DIR" ]; then
    cp -R "$BASE" "$DIR"
    case "$role" in
      files) model=${FILES_MODEL:-deepseek-v4-pro} ;;
      monitor) model=${MONITOR_MODEL:-deepseek-v4-pro} ;;
      personal) model=${PERSONAL_MODEL:-deepseek-v4-pro} ;;
    esac
    printf '%s\n' "- id: agent-default-model" "  config:" "    provider: deepseek-official" "    model: $model" > "$DIR/cordis.patch.yml"
    chown -R agent:agent "$DIR" 2>/dev/null || true
  fi
done
