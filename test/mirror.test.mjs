import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBotHarness } from './helpers.mjs'

/** Сообщение владельца в приватный чат. */
const update = (text, messageId = 1) => ({
  kind: 'message', id: messageId, chat: { id: 42, type: 'private' },
  from: { id: 42, name: 'В', isBot: false }, text, attachments: [], addressed: true, messageId,
})

const okRun = (text) => ({ async run() { return { ok: true, text, usage: { steps: 1, totalTokens: 100, promptTokens: 100, completionTokens: 10, totalCostUsd: 0 }, durationMs: 1000, exitCode: 0 } } })

test('обычная задача: зеркалируется ровно один раз — результат', async () => {
  const mirrored = []
  const env = await createBotHarness({ mirror: async (text) => { mirrored.push(text) }, runner: okRun('Готово: отчёт собран') })
  try {
    await env.bot.handleUpdate(update('сделай отчёт по продажам'))
    await env.bot.worker
    assert.equal(mirrored.length, 1, `ожидали одно зеркалирование, получили ${mirrored.length}`)
    assert.match(mirrored[0], /Готово: отчёт собран/)
    assert.equal(/приступаю|выполнена/.test(mirrored[0]), false, 'служебные тексты не зеркалируются')
  } finally {
    await env.close()
  }
})

test('verbose-режим: статусы не зеркалируются, только результат', async () => {
  const mirrored = []
  const env = await createBotHarness({
    configEnv: { REPORT_STYLE: 'verbose' },
    mirror: async (text) => { mirrored.push(text) },
    runner: okRun('готово'),
  })
  try {
    await env.bot.handleUpdate(update('посчитай что-нибудь'))
    await env.bot.worker
    assert.equal(mirrored.length, 1, `в бота ушло ${mirrored.length} сообщений`)
    assert.match(mirrored[0], /готово/)
  } finally {
    await env.close()
  }
})

test('вопрос владельцу зеркалируется, служебная строка — нет', async () => {
  const mirrored = []
  const env = await createBotHarness({
    mirror: async (text) => { mirrored.push(text) },
    runner: okRun('ВОПРОС: какой нужен формат отчёта?'),
  })
  try {
    await env.bot.handleUpdate(update('сделай отчёт'))
    await env.bot.worker
    assert.equal(mirrored.length, 1)
    assert.match(mirrored[0], /какой нужен формат отчёта\?/)
    assert.equal(/жду ответа/.test(mirrored[0]), false)
  } finally {
    await env.close()
  }
})

test('варианты зеркалируются в бота', async () => {
  const mirrored = []
  const env = await createBotHarness({
    mirror: async (text) => { mirrored.push(text) },
    runner: okRun('ВАРИАНТ 1: кратко\nВАРИАНТ 2: подробно'),
  })
  try {
    await env.bot.handleUpdate(update('сделай отчёт'))
    await env.bot.worker
    assert.equal(mirrored.length, 1)
    assert.match(mirrored[0], /кратко/)
  } finally {
    await env.close()
  }
})

test('ошибка зеркалирования не ломает задачу', async () => {
  const env = await createBotHarness({
    mirror: async () => { throw new Error('точка приёма недоступна') },
    runner: okRun('готово'),
  })
  try {
    await env.bot.handleUpdate(update('сделай отчёт'))
    await env.bot.worker
    assert.ok(env.platform.sent.some((entry) => /готово/.test(entry.markdown)), 'ответ владельцу ушёл')
  } finally {
    await env.close()
  }
})
