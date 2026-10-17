#!/usr/bin/env bash
# Проверка структуры OpenSpec; работает независимо от текущего каталога.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
find_node() {
  for candidate in "${NODE:-}" \
    /Users/andryukovy/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node \
    "$(command -v node 2>/dev/null || true)" /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}
node=$(find_node) || { echo "spec-check: не нашёл node. Укажите NODE=/путь/к/node" >&2; exit 127; }
exec "$node" "$here/spec-check.mjs" "$root"
