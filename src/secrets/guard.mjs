/**
 * Защита от секретов в памяти, промптах и отчётах (PLA-17).
 *
 * Значения секретов в память не попадают. Полный список значений окружения
 * доступен только точке сборки; здесь — шаблоны типовых ключей и функция
 * вырезания, которой достаточно, чтобы не отправить ключ в модель или владельцу.
 */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /bot\d{6,}:[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
  /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["']?[^\s"']{8,}/gi,
]

/** True when the text looks like it contains a secret value. */
export function containsSecret(text) {
  const value = String(text ?? '')
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(value)
  })
}

/** Replace secret-looking fragments, keeping the surrounding text readable. */
export function redactSecrets(text) {
  let value = String(text ?? '')
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    value = value.replace(pattern, '[секрет вырезан]')
  }
  return value
}
