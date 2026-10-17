/**
 * Крипто секретов: чистые функции, проверяемые без файлов и процессов.
 *
 * Конверт совместим с прежним форматом: `{v:1, kdf:'scrypt', cipher:'aes-256-gcm',
 * salt, iv, tag, data}`. Ключ выводится из пароля через scrypt.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const SCRYPT = { N: 16384, r: 8, p: 1 }
const ENVELOPE_VERSION = 1

/** Ошибка домена: код совпадает с прежними кодами возврата CLI (2 — пароль/команда, 3 — дешифровка). */
export class SecretsError extends Error {
  constructor(message, code = 1) {
    super(message)
    this.name = 'SecretsError'
    this.code = code
  }
}

/** Ключ шифрования из пароля и соли. */
export function keyFromPassphrase(passphrase, salt) {
  return scryptSync(passphrase, salt, 32, SCRYPT)
}

/** Проверить конверт; вернуть его же. */
export function assertEnvelope(envelope) {
  if (!envelope || envelope.v !== ENVELOPE_VERSION || !envelope.salt || !envelope.iv
    || !envelope.tag || !envelope.data) {
    throw new SecretsError('незнакомый формат конверта (ожидался v=1)')
  }
  return envelope
}

/** Зашифровать текст: вернуть конверт для записи в файл. */
export function seal(text, passphrase) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFromPassphrase(passphrase, salt), iv)
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return {
    v: ENVELOPE_VERSION,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

/** Расшифровать конверт; при неверном пароле — ошибка с кодом 3. */
export function open(envelope, passphrase) {
  assertEnvelope(envelope)
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyFromPassphrase(passphrase, Buffer.from(envelope.salt, 'base64')),
      Buffer.from(envelope.iv, 'base64'),
    )
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new SecretsError('не расшифровывается: неверный пароль или файл повреждён', 3)
  }
}

/** Имена переменных из текста окружения — без значений. */
export function parseEnvNames(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => line.split('=')[0])
}

/** Замаскировать значения секретов в тексте (для логов и сообщений об ошибках). */
export function mask(text, values = []) {
  let result = String(text ?? '')
  for (const value of values) {
    if (typeof value === 'string' && value.length >= 4) result = result.split(value).join('***')
  }
  return result
}
