/**
 * Домен секретов: шифртекст окружения на диске.
 *
 * Единственное место, которое читает и пишет `secrets/agent.env.enc`. Пароль приходит
 * снаружи (из окружения) и никогда не пишется в argv, файлы и логи.
 */
import fs from 'node:fs'
import path from 'node:path'
import { assertEnvelope, mask, open, parseEnvNames, seal, SecretsError } from './crypto.mjs'

// Публичная поверхность домена: крипто нужно тестам и проверкам, файлы — CLI и деплою.
export { assertEnvelope, mask, open, parseEnvNames, seal, SecretsError }

/** Пути по умолчанию внутри проекта. */
export function defaultPaths(root = process.cwd()) {
  return {
    plainPath: path.resolve(root, 'secrets/agent.env'),
    encryptedPath: path.resolve(root, 'secrets/agent.env.enc'),
  }
}

/** Зашифровать файл окружения в конверт рядом с ним. */
export function encryptFile({ plainPath, encryptedPath, passphrase }) {
  if (!passphrase) throw new SecretsError('нет пароля: задайте SECRETS_PASSPHRASE в окружении', 2)
  let text
  try {
    text = fs.readFileSync(plainPath, 'utf8')
  } catch {
    throw new SecretsError(`не читается ${plainPath}`)
  }
  if (text.trim() === '') throw new SecretsError(`${plainPath} пуст — нечего шифровать`)
  fs.mkdirSync(path.dirname(encryptedPath), { recursive: true })
  fs.writeFileSync(encryptedPath, JSON.stringify(seal(text, passphrase), null, 2) + '\n', { mode: 0o600 })
  return { encryptedPath }
}

/** Прочитать и проверить конверт; вернуть текст окружения. */
export function readEncrypted(encryptedPath, passphrase) {
  if (!passphrase) throw new SecretsError('нет пароля: задайте SECRETS_PASSPHRASE в окружении', 2)
  let raw
  try {
    raw = fs.readFileSync(encryptedPath, 'utf8')
  } catch {
    throw new SecretsError(`не читается ${encryptedPath}: секреты ещё не зашифрованы`)
  }
  let envelope
  try {
    envelope = assertEnvelope(JSON.parse(raw))
  } catch (error) {
    if (error instanceof SecretsError) throw error
    throw new SecretsError(`${encryptedPath} повреждён`)
  }
  return open(envelope, passphrase)
}

/** Расшифровать конверт в файл с правами 600. */
export function decryptFile({ plainPath, encryptedPath, passphrase }) {
  const text = readEncrypted(encryptedPath, passphrase)
  fs.mkdirSync(path.dirname(plainPath), { recursive: true })
  fs.writeFileSync(plainPath, text, { mode: 0o600 })
  fs.chmodSync(plainPath, 0o600)
  return { plainPath, names: parseEnvNames(text) }
}

/** Проверить, что конверт расшифровывается; вернуть имена переменных без значений. */
export function checkFile({ encryptedPath, passphrase }) {
  return { names: parseEnvNames(readEncrypted(encryptedPath, passphrase)) }
}
