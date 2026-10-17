/**
 * Проверка результата в задаче: статусы done/partial, отчёт и явный выключатель.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { STATUS } from '../src/storage/tasks.mjs'
import { createBotHarness } from './helpers.mjs'

const message = (text, messageId = 1) => ({
  kind: 'message', id: messageId, chat: { id: 42, type: 'private' },
  from: { id: 42, name: 'В', isBot: false }, text, attachments: [], addressed: true, messageId,
})

/** Задача пишет файл-результат, чтобы проверка стала применимой. */
const docRunner = () => ({
  async run() {
    return {
      ok: true, exitCode: 0, timedOut: false, aborted: false, text: 'Готово: отчёт',
      sessionId: 's1', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, steps: 1 },
      tools: [], errors: [], stderr: '', durationMs: 50,
    }
  },
})

function verifierStub(result, { enabled = true, applicable = true } = {}) {
  return {
    enabled,
    applicable: () => applicable,
    evaluate: async () => result,
    disabled: () => ({ status: 'disabled', criteria: [], limitations: ['VERIFY=false'], checkedAt: Date.now() }),
    notRequired: () => ({ status: 'not_required', criteria: [], limitations: [], checkedAt: Date.now() }),
  }
}

test('a verified result is done and the report names the check', async () => {
  let env
  env = await createBotHarness({
    verifier: verifierStub({ status: 'passed', criteria: [{ id: 'opens', status: 'passed', evidence: 'файл открывается' }], limitations: [] }),
    runner: {
      async run() {
        await fs.writeFile(path.join(env.ws, 'outbox', 'отчёт.docx'), 'x')
        return docRunner().run()
      },
    },
  })
  try {
    await env.bot.handleUpdate(message('сделай отчёт в docx'))
    await env.bot.worker
    const record = env.journal.recent(1)[0]
    assert.equal(record.status, STATUS.done)
    assert.equal(record.verification.status, 'passed')
    const sent = env.platform.sent.map((entry) => entry.markdown).join('\n')
    assert.match(sent, /Проверка: пройдена/)
  } finally {
    await env.close()
  }
})

test('a failed check makes the task partial and the report does not claim success', async () => {
  let env
  env = await createBotHarness({
    verifier: verifierStub({ status: 'failed', criteria: [{ id: 'sections', status: 'failed', evidence: 'нет раздела «Выводы»' }], limitations: ['нет раздела'] }),
    runner: {
      async run() {
        await fs.writeFile(path.join(env.ws, 'outbox', 'отчёт.docx'), 'x')
        return docRunner().run()
      },
    },
  })
  try {
    await env.bot.handleUpdate(message('сделай отчёт в docx'))
    await env.bot.worker
    const record = env.journal.recent(1)[0]
    assert.equal(record.status, STATUS.partial)
    const sent = env.platform.sent.map((entry) => entry.markdown).join('\n')
    assert.match(sent, /частично/i)
    assert.match(sent, /Не прошло: sections/)
  } finally {
    await env.close()
  }
})

test('VERIFY=false is explicit: done with a disabled note', async () => {
  const env = await createBotHarness({
    verifier: verifierStub(undefined, { enabled: false }),
    runner: docRunner(),
  })
  try {
    await env.bot.handleUpdate(message('просто ответь: готово'))
    await env.bot.worker
    const record = env.journal.recent(1)[0]
    assert.equal(record.status, STATUS.done)
    assert.equal(record.verification.status, 'disabled')
    const sent = env.platform.sent.map((entry) => entry.markdown).join('\n')
    assert.match(sent, /Проверка отключена \(VERIFY=false\)/)
  } finally {
    await env.close()
  }
})

test('not required is not mixed with unavailable or partial', async () => {
  const env = await createBotHarness({
    verifier: verifierStub(undefined, { applicable: false }),
    runner: docRunner(),
  })
  try {
    await env.bot.handleUpdate(message('ответь одним словом: ок'))
    await env.bot.worker
    const record = env.journal.recent(1)[0]
    assert.equal(record.status, STATUS.done)
    assert.equal(record.verification.status, 'not_required')
    const sent = env.platform.sent.map((entry) => entry.markdown).join('\n')
    assert.match(sent, /Проверка не требуется/)
  } finally {
    await env.close()
  }
})
