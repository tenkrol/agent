/**
 * CLI домена секретов. Здесь разрешено читать SECRETS_PASSPHRASE и PROJECT_ROOT:
 * пароль по определению не хранится в конфиге и не передаётся в argv.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkFile, decryptFile, encryptFile, SecretsError } from './index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = process.env.PROJECT_ROOT ?? path.resolve(here, '../..')
const args = process.argv.slice(2)
const command = args.find((arg) => !arg.startsWith('--'))
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}
const plainPath = path.resolve(root, option('in', 'secrets/agent.env'))
const encryptedPath = path.resolve(root, option('out', 'secrets/agent.env.enc'))
const passphrase = process.env.SECRETS_PASSPHRASE ?? ''
const relative = (file) => path.relative(root, file)

function fail(message, code = 1) {
  console.error(`secrets: ${message}`)
  process.exit(code)
}

try {
  if (!command) fail('команда: encrypt | decrypt | check', 2)
  if (command === 'encrypt') {
    encryptFile({ plainPath, encryptedPath, passphrase })
    console.log(`зашифровано: ${relative(plainPath)} → ${relative(encryptedPath)} (открытым текстом в репозиторий не попадает)`)
  } else if (command === 'decrypt') {
    decryptFile({ plainPath, encryptedPath, passphrase })
    console.log(`расшифровано: ${relative(encryptedPath)} → ${relative(plainPath)} (права 600)`)
  } else if (command === 'check') {
    const { names } = checkFile({ encryptedPath, passphrase })
    console.log(`проверка прошла: файл расшифровывается, переменных ${names.length}, имён: ${names.join(', ')}`)
  } else {
    fail(`неизвестная команда «${command}»`, 2)
  }
} catch (error) {
  if (error instanceof SecretsError) fail(error.message, error.code)
  throw error
}
