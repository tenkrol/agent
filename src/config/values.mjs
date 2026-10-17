/**
 * Валидаторы значений окружения и ошибка конфига.
 *
 * Живут отдельно от сборки конфига, чтобы каждый можно было проверить по одному.
 */
export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

const described = (raw) => `получено значение длиной ${String(raw).length}`

export function positiveInt(raw, key, { min = 1, max = Number.MAX_SAFE_INTEGER, allowZero = false } = {}) {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : min) || value > max) {
    throw new ConfigError(`${key}: нужно целое число ${allowZero ? `от 0` : `от ${min}`} до ${max}, ${described(raw)}`)
  }
  return value
}

/** Parse a boolean written as true/false/1/0/yes/no. */
export function boolean(raw, key) {
  const value = String(raw).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(value)) return true
  if (['false', '0', 'no', 'off'].includes(value)) return false
  throw new ConfigError(`${key}: нужно true или false, ${described(raw)}`)
}

/** Parse a non-negative number (prices are fractions of a dollar). */
export function nonNegativeNumber(raw, key, { max = 1_000_000 } = {}) {
  const value = Number(String(raw).trim().replace(',', '.'))
  if (!Number.isFinite(value) || value < 0 || value > max) {
    throw new ConfigError(`${key}: нужно число от 0 до ${max}, ${described(raw)}`)
  }
  return value
}

/** «ЧЧ:ММ» в минуты от полуночи; «off» или пусто — выключено. */
export function clockMinutes(raw, key) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === '' || value === 'off') return undefined
  const match = value.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) throw new ConfigError(`${key}: нужно время вида ЧЧ:ММ или off`)
  const minutes = Number(match[1]) * 60 + Number(match[2])
  if (minutes > 1439) throw new ConfigError(`${key}: время вне суток`)
  return minutes
}

/** A choice from a closed set, reported without echoing the value. */
export function choice(raw, key, allowed, fallback) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === '' || value === fallback) return fallback
  if (!allowed.includes(value)) throw new ConfigError(`${key}: нужно одно из ${allowed.join(', ')}`)
  return value
}

/** A number in a range, for speeds and ratios. */
export function numberInRange(raw, key, { min, max }) {
  const value = Number(String(raw).trim().replace(',', '.'))
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${key}: нужно число от ${min} до ${max}, ${described(raw)}`)
  }
  return value
}

/** The variants mode: auto (decide by the task), always, never. */
export function variantsMode(raw) {
  const value = String(raw).trim().toLowerCase()
  if (!['auto', 'always', 'never'].includes(value)) {
    throw new ConfigError('PROPOSE_VARIANTS: нужно auto, always или never')
  }
  return value
}

/** Require an absolute path, without touching the filesystem. */
export function absolutePath(raw, key) {
  const value = String(raw).trim()
  if (!value.startsWith('/')) throw new ConfigError(`${key}: нужен абсолютный путь (начинается с /)`)
  return value.replace(/\/+$/, '') || '/'
}

/** Telegram user ids from a comma/space separated list. */
export function parseUserIds(raw) {
  return new Set(String(raw ?? '')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item !== ''))
}

/**
 * Build the agent configuration from an environment object.
 *
 * @param {Record<string, string|undefined>} [env] - environment, defaults to `process.env`.
 * @returns {object} validated configuration.
 * @throws {ConfigError} when a required value is missing or malformed.
 */
