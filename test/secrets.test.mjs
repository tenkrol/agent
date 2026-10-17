import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  checkFile,
  decryptFile,
  encryptFile,
  mask,
  open,
  parseEnvNames,
  seal,
  SecretsError,
} from '../src/secrets/index.mjs'

const PASS = 'пароль-проверки-123'
const ENV_TEXT = 'TELEGRAM_BOT_TOKEN=123:abc\nMODEL_API_KEY=sk-test\n# комментарий\n\n'

/** Временный каталог на один тест. */
const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'secrets-test-'))

test('шифрование и расшифровка возвращают исходный текст', () => {
  const envelope = seal(ENV_TEXT, PASS)
  assert.equal(envelope.v, 1)
  assert.ok(envelope.salt && envelope.iv && envelope.tag && envelope.data)
  assert.equal(open(envelope, PASS), ENV_TEXT)
})

test('неверный пароль даёт ошибку с кодом 3 и не выдаёт текст', () => {
  const envelope = seal(ENV_TEXT, PASS)
  assert.throws(() => open(envelope, 'другой-пароль'), (error) => {
    assert.ok(error instanceof SecretsError)
    assert.equal(error.code, 3)
    assert.match(error.message, /не расшифровывается/)
    return true
  })
})

test('повреждённый конверт отвергается понятной ошибкой', () => {
  assert.throws(() => open({ v: 2, data: 'x' }, PASS), /незнакомый формат конверта/)
})

test('файлы: encrypt → decrypt → check, права 600, без значений в проверке', async () => {
  const dir = await tempDir()
  try {
    const plainPath = path.join(dir, 'agent.env')
    const encryptedPath = path.join(dir, 'agent.env.enc')
    await fs.writeFile(plainPath, ENV_TEXT, 'utf8')

    await encryptFile({ plainPath, encryptedPath, passphrase: PASS })
    const encrypted = await fs.readFile(encryptedPath, 'utf8')
    assert.equal(encrypted.includes('TELEGRAM_BOT_TOKEN=123:abc'), false, 'значения в шифртексте нет')

    await fs.rm(plainPath)
    const restored = await decryptFile({ plainPath, encryptedPath, passphrase: PASS })
    assert.deepEqual(restored.names, ['TELEGRAM_BOT_TOKEN', 'MODEL_API_KEY'])
    const mode = (await fs.stat(plainPath)).mode & 0o777
    assert.equal(mode, 0o600, 'расшифрованный файл только для владельца')
    assert.equal(await fs.readFile(plainPath, 'utf8'), ENV_TEXT)

    const check = await checkFile({ encryptedPath, passphrase: PASS })
    assert.deepEqual(check.names, ['TELEGRAM_BOT_TOKEN', 'MODEL_API_KEY'])
    assert.equal(JSON.stringify(check).includes('sk-test'), false, 'значений в результате нет')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('нет пароля и нет файла — понятные ошибки', async () => {
  assert.throws(
    () => encryptFile({ plainPath: '/tmp/none', encryptedPath: '/tmp/none.enc', passphrase: '' }),
    /нет пароля/,
  )
  const dir = await tempDir()
  try {
    assert.throws(
      () => checkFile({ encryptedPath: path.join(dir, 'missing.enc'), passphrase: PASS }),
      /секреты ещё не зашифрованы/,
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('маскирование скрывает значения, имена переменных не искажает', () => {
  const values = ['sk-test', '123:abc']
  const text = `ключ sk-test и токен 123:abc`
  assert.equal(mask(text, values), 'ключ *** и токен ***')
  assert.deepEqual(parseEnvNames(ENV_TEXT), ['TELEGRAM_BOT_TOKEN', 'MODEL_API_KEY'])
})

test('реестр имён не содержит значений', async () => {
  const text = await fs.readFile('secrets/keys.md', 'utf8')
  assert.match(text, /\| Переменная \|/, 'таблица реестра на месте')
  assert.match(text, /TELEGRAM_BOT_TOKEN/)
  // Длинные строки из букв, цифр и знаков — признак реального значения ключа.
  const suspicious = text.split('\n').filter((line) => /[A-Za-z0-9_\-/+=]{32,}/.test(line))
  assert.deepEqual(suspicious, [], `в реестре похожее на значение: ${suspicious.join(' | ')}`)
})
