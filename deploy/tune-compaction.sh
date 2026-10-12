#!/usr/bin/env bash
#
# Ранняя компакция контекста DSH.
#
# ВАЖНО (проверено 2026-10-12): в headless-профиле эффекта нет. A/B на двух
# одинаковых сессиях по 115 тыс. токенов показал одинаковый контекст и до, и после
# (thresholdRatio 0.06 против 0.8) — автоматическая компакция между шагами не
# срабатывает даже с явно указанной моделью-суммаризатором. Скрипт оставлен как
# воспроизводимая запись попытки и как готовая настройка на случай, если поведение
# плагина в DSH изменится; install-remote.sh его не вызывает. Предел контекста
# реализован в самом боте (SESSION_MAX_TOKENS).
#
# По умолчанию DSH сжимает историю только при 80% окна модели — у deepseek-flash
# это около 839 000 токенов, а после сжатия оставляет 16% (≈165 000). Наши задачи
# до такого порога не дотягивают, поэтому компакция не срабатывает никогда, и
# каждый следующий шаг оплачивает весь накопленный контекст: расход ≈ шаги × контекст.
#
# Этот скрипт ставит в профиль патч с порогом «сжимать рано, оставлять мало»:
#
#   thresholdRatio 0.06 → порог ≈ 63 000 токенов (0.06 × 1 048 576)
#   retainTokens 12000  → после сжатия остаётся хвост 12 000 токенов
#   headroomTokens 8000 → запас на ответ
#
# Запуск на сервере (нужен root: профиль лежит в DSH_HOME агента):
#
#   bash /opt/agent/deploy/tune-compaction.sh            # применить
#   bash /opt/agent/deploy/tune-compaction.sh --show     # показать текущее
#
# install-remote.sh вызывает его сам, так что деплой всегда несёт эту настройку.
set -euo pipefail

DSH_HOME=${DSH_HOME:-/var/lib/agent/dsh}
PROFILE=${DSH_PROFILE:-headless}
PATCH="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"
SERVICE_USER=${SERVICE_USER:-agent}
THRESHOLD_RATIO=${COMPACT_THRESHOLD_RATIO:-0.06}
RETAIN_TOKENS=${COMPACT_RETAIN_TOKENS:-12000}
HEADROOM_TOKENS=${COMPACT_HEADROOM_TOKENS:-8000}
# Без явной модели-суммаризатора плагин не сжимает: он просто не знает, кем
# пересказывать историю (в конфиге по умолчанию эти поля пустые).
SUMMARIZATION_PROVIDER=${COMPACT_SUMMARIZATION_PROVIDER:-deepseek-official}
SUMMARIZATION_MODEL=${COMPACT_SUMMARIZATION_MODEL:-deepseek-flash}

log() { printf '\n=== %s\n' "$*"; }
die() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }

BEGIN_MARK='# >>> agent-compaction (управляется deploy/tune-compaction.sh)'
END_MARK='# <<< agent-compaction'

if [ "${1:-}" = "--show" ]; then
  [ -f "$PATCH" ] && cat "$PATCH" || printf 'патча нет: %s\n' "$PATCH"
  exit 0
fi

[ "$(id -u)" = "0" ] || die "запустите через sudo"
[ -d "$DSH_HOME/profiles/$PROFILE" ] || die "нет профиля $DSH_HOME/profiles/$PROFILE"

log "патч профиля $PROFILE"
install -d -m 0755 "$(dirname "$PATCH")"
TMP=$(mktemp)
if [ -f "$PATCH" ]; then
  # Чужое содержимое сохраняем: убираем только свой блок.
  python3 - "$PATCH" "$BEGIN_MARK" "$END_MARK" > "$TMP" <<'PY'
import sys
path, begin, end = sys.argv[1], sys.argv[2], sys.argv[3]
keep, skipping = [], False
for line in open(path, encoding='utf-8'):
    if line.strip() == begin:
        skipping = True
        continue
    if line.strip() == end:
        skipping = False
        continue
    if not skipping:
        keep.append(line.rstrip('\n'))
# Пустой документ (`[]`) и одни комментарии — это «ничего нет».
meaningful = [line for line in keep if line.strip() and not line.strip().startswith('#') and line.strip() != '[]']
print('\n'.join(meaningful))
PY
else
  : > "$TMP"
fi

{
  cat "$TMP"
  printf '%s\n' "$BEGIN_MARK"
  printf -- '- id: compaction-basic\n'
  printf '  config:\n'
  printf '    auto: true\n'
  printf '    thresholdRatio: %s\n' "$THRESHOLD_RATIO"
  printf '    retainTokens: %s\n' "$RETAIN_TOKENS"
  printf '    headroomTokens: %s\n' "$HEADROOM_TOKENS"
  [ -n "$SUMMARIZATION_PROVIDER" ] && printf '    summarizationProvider: %s\n' "$SUMMARIZATION_PROVIDER"
  [ -n "$SUMMARIZATION_MODEL" ] && printf '    summarizationModel: %s\n' "$SUMMARIZATION_MODEL"
  printf '%s\n' "$END_MARK"
} > "${TMP}.new"
rm -f "$TMP"
mv "${TMP}.new" "$PATCH"
chown "$SERVICE_USER:$SERVICE_USER" "$PATCH" 2>/dev/null || true

log "проверка, что профиль принимает патч"
cd "$DSH_HOME/.." 2>/dev/null || cd /
if HOME="$DSH_HOME" DSH_HOME="$DSH_HOME" dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -A 6 'id: compaction-basic' | grep -q 'thresholdRatio'; then
  HOME="$DSH_HOME" DSH_HOME="$DSH_HOME" dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -A 6 'id: compaction-basic'
  printf '\nГотово: компакция сработает примерно на %s токенах, оставит %s.\n' \
    "$(python3 -c "print(f'{int(1048576 * float('$THRESHOLD_RATIO')):,}'.replace(',', ' '))")" "$RETAIN_TOKENS"
else
  die "профиль не подхватил патч — проверьте $PATCH"
fi
