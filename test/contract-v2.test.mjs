/**
 * Контракт v2 на уровне HTTP: маршруты, коды, файлы, обязательный requestId.
 *
 * Ядро подменено простыми обработчиками: тест проверяет форму протокола, а не
 * выполнение задачи (оно покрыто route-v2).
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { createBridgeServer } from '../src/bot-link/bridge-http.mjs'
import { FileStore } from '../src/storage/files.mjs'
import { cleanup, createTestLogger, tempDir } from './helpers.mjs'

const TOKEN = 'contract-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

async function startServer({ files, contractV2 = true, handlers = {} } = {}) {
  const seen = { tasks: [], replies: [], cancels: [] }
  const server = createBridgeServer({
    token: TOKEN,
    port: 0,
    contractV2,
    routeConfig: { botId: '999', chatId: '42' },
    files,
    logger: createTestLogger(),
    onSubmit: async () => ({ taskId: 'legacy-1' }),
    onSubmitV2: async (request) => {
      seen.tasks.push(request)
      return handlers.onSubmit ? handlers.onSubmit(request) : { taskId: 'task-1', duplicate: false, state: 'queued' }
    },
    getTask: (id) => (id === 'task-1' ? { id, execution: 'queued', delivery: { state: 'pending' } } : undefined),
    onReply: async (id, body) => {
      seen.replies.push({ id, body })
      return { taskId: id, state: 'queued' }
    },
    onCancel: async (id, body) => {
      seen.cancels.push({ id, body })
      return { taskId: id, state: 'cancelled' }
    },
  })
  const address = await server.start()
  return { server, seen, url: `http://127.0.0.1:${address.port}` }
}

const taskBody = (extra = {}) => JSON.stringify({
  contract: 2,
  requestId: 'req-1',
  task: 'сделай отчёт',
  route: { platform: 'telegram', botId: '999', chatId: '42', messageId: 5 },
  ...extra,
})

test('health is open and reports contract 2, everything else needs a token', async () => {
  const dir = await tempDir()
  const files = await new FileStore({ dir: path.join(dir, 'files'), file: path.join(dir, 'files.jsonl') }).load()
  const { server, url } = await startServer({ files })
  try {
    const health = await fetch(`${url}/v1/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true, service: 'agent-bridge', contract: 2 })

    const noToken = await fetch(`${url}/v1/tasks`, { method: 'POST', body: taskBody() })
    assert.equal(noToken.status, 401)
    const capabilities = await fetch(`${url}/v1/capabilities`, { headers: AUTH })
    assert.equal(capabilities.status, 200)
    const caps = await capabilities.json()
    assert.equal(caps.contract, 2)
    assert.equal(caps.files, true)
    assert.equal(caps.reply, true)
    assert.equal(caps.cancel, true)
  } finally {
    await server.stop()
    await cleanup(dir)
  }
})

test('a v2 task with a route, facts and file refs is accepted', async () => {
  const dir = await tempDir()
  const files = await new FileStore({ dir: path.join(dir, 'files'), file: path.join(dir, 'files.jsonl') }).load()
  const record = await files.create({ bytes: Buffer.from('данные'), name: 'план.docx', mime: 'application/msword', direction: 'input' })
  const { server, seen, url } = await startServer({ files })
  try {
    const response = await fetch(`${url}/v1/tasks`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: taskBody({
        attachments: [{ fileId: record.fileId, kind: 'document', name: 'план.docx' }],
        context: { facts: [{ text: 'часовой пояс — Москва', subject: 'timezone' }] },
      }),
    })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { ok: true, contract: 2, taskId: 'task-1', state: 'queued', duplicate: false })
    assert.equal(seen.tasks.length, 1)
    assert.equal(seen.tasks[0].route.chatId, '42')
    assert.equal(seen.tasks[0].attachments[0].fileId, record.fileId)
    assert.equal(seen.tasks[0].facts[0].subject, 'timezone')
  } finally {
    await server.stop()
    await cleanup(dir)
  }
})

test('missing requestId, bad route and unknown fileId are rejected', async () => {
  const dir = await tempDir()
  const files = await new FileStore({ dir: path.join(dir, 'files'), file: path.join(dir, 'files.jsonl') }).load()
  const { server, seen, url } = await startServer({ files })
  const post = (body) => fetch(`${url}/v1/tasks`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body })
  try {
    assert.equal((await post(JSON.stringify({ contract: 2, task: 'без ключа' }))).status, 400)
    assert.equal((await post(taskBody({ route: { platform: 'telegram', botId: '1', chatId: '2' } }))).status, 400)
    assert.equal((await post(taskBody({ attachments: [{ fileId: 'f_unknown' }] }))).status, 400)
    assert.equal(seen.tasks.length, 0)
  } finally {
    await server.stop()
    await cleanup(dir)
  }
})

test('state, reply and cancel answer with the contract shape', async () => {
  const dir = await tempDir()
  const files = await new FileStore({ dir: path.join(dir, 'files'), file: path.join(dir, 'files.jsonl') }).load()
  const { server, seen, url } = await startServer({ files })
  try {
    const state = await fetch(`${url}/v1/tasks/task-1`, { headers: AUTH })
    assert.equal(state.status, 200)
    const payload = await state.json()
    assert.equal(payload.task.execution, 'queued')
    assert.equal((await fetch(`${url}/v1/tasks/nope`, { headers: AUTH })).status, 404)

    const reply = await fetch(`${url}/v1/tasks/task-1/reply`, {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ contract: 2, requestId: 'reply-1', text: 'DOCX' }),
    })
    assert.equal(reply.status, 202)
    assert.equal(seen.replies[0].body.text, 'DOCX')

    const cancel = await fetch(`${url}/v1/tasks/task-1/cancel`, {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ contract: 2, requestId: 'cancel-1' }),
    })
    assert.equal(cancel.status, 200)
    assert.equal(seen.cancels[0].body.requestId, 'cancel-1')
  } finally {
    await server.stop()
    await cleanup(dir)
  }
})

test('files: multipart upload, token download, 404 and 410', async () => {
  const dir = await tempDir()
  const files = await new FileStore({ dir: path.join(dir, 'files'), file: path.join(dir, 'files.jsonl') }).load()
  const { server, url } = await startServer({ files })
  const boundary = '----test-boundary'
  const multipart = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="отчёт.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from('привет'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  try {
    const upload = await fetch(`${url}/v1/files`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: multipart,
    })
    assert.equal(upload.status, 201)
    const meta = await upload.json()
    assert.match(meta.fileId, /^f_/)
    assert.equal(meta.size, Buffer.byteLength('привет'))

    const download = await fetch(`${url}/v1/files/${meta.fileId}`, { headers: AUTH })
    assert.equal(download.status, 200)
    assert.equal(Buffer.from(await download.arrayBuffer()).toString(), 'привет')
    assert.equal((await fetch(`${url}/v1/files/f_unknown`, { headers: AUTH })).status, 404)
    assert.equal((await fetch(`${url}/v1/files/${meta.fileId}`)).status, 401)
  } finally {
    await server.stop()
    await cleanup(dir)
  }
})

test('an expired file is 410', async () => {
  const dir = await tempDir()
  // TTL -1 день: файл создаётся уже истёкшим.
  const files = await new FileStore({ dir: path.join(dir, 'files'), file: path.join(dir, 'files.jsonl'), inputTtlDays: -1 }).load()
  const record = await files.create({ bytes: Buffer.from('старое'), name: 'old.txt', direction: 'input' })
  const { server, url } = await startServer({ files })
  try {
    assert.equal((await fetch(`${url}/v1/files/${record.fileId}`, { headers: AUTH })).status, 410)
  } finally {
    await server.stop()
    await cleanup(dir)
  }
})

test('legacy /bridge still works and contract v2 can be disabled', async () => {
  const dir = await tempDir()
  const files = await new FileStore({ dir: path.join(dir, 'files'), file: path.join(dir, 'files.jsonl') }).load()
  const { server, url } = await startServer({ files, contractV2: false })
  try {
    const legacy = await fetch(`${url}/bridge`, {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'старый запрос', source: 'chat-bot' }),
    })
    assert.equal(legacy.status, 202)
    assert.equal((await legacy.json()).taskId, 'legacy-1')
    const v2 = await fetch(`${url}/v1/tasks`, {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: taskBody(),
    })
    assert.equal(v2.status, 404)
  } finally {
    await server.stop()
    await cleanup(dir)
  }
})
