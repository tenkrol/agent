/**
 * Личные процедуры: черновик → активация, версии, запуск.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { ProceduresStore } from '../src/storage/procedures.mjs'
import { createProcedures } from '../src/procedures/index.mjs'
import { STATUS } from '../src/storage/tasks.mjs'
import { cleanup, createBotHarness, tempDir } from './helpers.mjs'

const criteria = [{ id: 'c1', text: 'есть разделы «Итоги», «Риски»', kind: 'sections', required: true, source: 'из запроса' }]

async function domainFor(dir) {
  const store = await new ProceduresStore({ file: path.join(dir, 'procedures.json') }).load()
  return { store, domain: createProcedures({ store, globalLimits: { tokenBudget: 1000, maxSteps: 5 } }) }
}

const taskRecord = {
  id: 't1',
  brief: 'еженедельный обзор',
  request: 'Собери обзор за неделю',
  files: ['outbox/обзор.docx'],
}

test('a procedure saved without all fields stays a draft and cannot run', async () => {
  const dir = await tempDir()
  try {
    const { domain } = await domainFor(dir)
    const saved = await domain.saveFromTask({ name: 'weekly', record: taskRecord, criteria: [] })
    assert.equal(saved.version.status, 'draft')
    assert.ok(saved.missing.includes('criteria'))
    assert.equal(domain.render({ name: 'weekly' }).ok, false)

    await domain.setField('weekly', 'criteria', criteria)
    await domain.setField('weekly', 'limits', '{"taskMaxSteps":3}')
    const active = await domain.activate('weekly')
    assert.equal(active.version.status, 'active')
    const rendered = domain.render({ name: 'weekly' })
    assert.equal(rendered.ok, true)
    assert.match(rendered.text, /Собери обзор/)
    assert.match(rendered.text, /Формат результата: DOCX/)
    assert.match(rendered.text, /Критерии проверки/)
    assert.equal(rendered.limits.taskMaxSteps, 3)
  } finally {
    await cleanup(dir)
  }
})

test('editing an active procedure creates an immutable new version', async () => {
  const dir = await tempDir()
  try {
    const { domain } = await domainFor(dir)
    await domain.saveFromTask({ name: 'weekly', record: taskRecord, criteria })
    const first = domain.activeVersion('weekly')
    assert.equal(first.version, 1)
    await domain.setField('weekly', 'purpose', 'новый обзор')
    const draft = domain.get('weekly').versions.find((version) => version.status === 'draft')
    assert.equal(draft.version, 2)
    assert.equal(domain.activeVersion('weekly').version, 1, 'действующая версия не изменилась')
    await domain.activate('weekly')
    assert.equal(domain.activeVersion('weekly').version, 2)
    assert.equal(domain.get('weekly').versions.find((version) => version.version === 1).status, 'archived')
  } finally {
    await cleanup(dir)
  }
})

test('limits above the global ceiling are rejected', async () => {
  const dir = await tempDir()
  try {
    const { domain } = await domainFor(dir)
    await domain.saveFromTask({ name: 'weekly', record: taskRecord, criteria })
    await domain.setField('weekly', 'purpose', 'обзор')
    await assert.rejects(() => domain.setField('weekly', 'limits', '{"taskTokenBudget":5000}'), /выше глобального/)
  } finally {
    await cleanup(dir)
  }
})

test('commands save, activate and run a procedure as a task', async () => {
  const env = await createBotHarness()
  try {
    await env.journal.open({ id: 't1', chatId: '42', brief: 'еженедельный обзор' })
    await env.journal.close('t1', {
      status: STATUS.done,
      request: 'Собери обзор за неделю',
      files: ['outbox/обзор.docx'],
      resultSummary: { text: 'готово', files: [], version: 1 },
    })
    const saved = await env.bot.procedureCommand({ args: 'save weekly t1' })
    assert.match(saved, /черновиком/)
    const listed = await env.bot.procedureCommand({ args: 'list' })
    assert.match(listed, /weekly/)
    const set = await env.bot.procedureCommand({ args: `set weekly criteria [{"id":"c1","text":"есть разделы","kind":"sections","required":true,"source":"из запроса"}]` })
    assert.match(set, /активируйте/)
    const activated = await env.bot.procedureCommand({ args: 'activate weekly' })
    assert.match(activated, /активна/)
    const run = await env.bot.procedureCommand({ args: 'run weekly' })
    assert.match(run, /Запускаю процедуру/)
    await env.bot.worker
    const record = env.journal.recent(1)[0]
    assert.equal(record.procedure.name, 'weekly')
    assert.equal(record.procedure.version, 1)
  } finally {
    await env.close()
  }
})
