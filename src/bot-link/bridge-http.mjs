/**
 * The bridge intake: an HTTP endpoint the chat bot in Spain calls.
 *
 * Telegram cannot carry this: a bot never receives messages sent by another bot
 * (measured on a live group — a plain mention, a `tg://user` link, an explicit
 * `mention` entity and a `/help@bot` command all stayed invisible). So the chat
 * bot talks to the agent directly.
 *
 * The listener binds to loopback only and is reached through an SSH tunnel opened
 * from Spain (`ssh -N -L 8787:127.0.0.1:8787`): no port is exposed to the
 * internet, TLS is unnecessary because SSH already encrypts the hop, and the
 * bearer token is the second factor.
 *
 * The handler never blocks the response on the task itself: it queues the task
 * and answers with its id, because a run can take twenty minutes.
 *
 * Два входа: контракт v2 (`/v1/*` — задачи, состояние, ответ, отмена, файлы) и
 * прежний `/bridge` для старого клиента. Коды ответа и тела описаны в
 * `openspec/changes/PLA-14/specs/bot-link/contract.md`.
 */
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { ProtocolError, parseCancelRequest, parseFileId, parseReplyRequest, parseTaskRequest } from './protocol.mjs'
import { fileMeta, parseMultipartFile } from './files.mjs'
import { freeSpace } from '../storage/files.mjs'

/** Bodies above this are refused before parsing. */
const DEFAULT_MAX_BYTES = 64 * 1024
/** Longest task text accepted from the bridge. */
const DEFAULT_MAX_TASK_CHARS = 4000
/** Uploaded contract files default cap. */
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024
/** Multipart overhead above the file itself. */
const MULTIPART_OVERHEAD = 64 * 1024

/** Compare two secrets without leaking their length through timing. */
function sameSecret(expected, received) {
  const a = Buffer.from(String(expected))
  const b = Buffer.from(String(received))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Read a request body with a hard size cap; returns a Buffer. */
function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

/** HTTP status for an error raised by a handler. */
function statusOf(error) {
  if (error instanceof ProtocolError) return error.status
  switch (error?.code) {
    case 'NOT_FOUND': return 404
    case 'CONFLICT': return 409
    case 'BAD_STATE': return 409
    case 'STORAGE_FAILED': return 503
    default: return 500
  }
}

export class BridgeServer {
  /**
   * @param {object} options - server options.
   * @param {string} options.token - shared secret; the server refuses to start without it.
   * @param {(request: object) => Promise<object>} [options.onSubmit] - прежний `/bridge`.
   * @param {(request: object) => Promise<object>} [options.onSubmitV2] - `POST /v1/tasks`.
   * @param {(id: string) => object|undefined} [options.getTask] - `GET /v1/tasks/:id`.
   * @param {(id: string, body: object) => Promise<object>} [options.onReply] - `POST /reply`.
   * @param {(id: string, body: object) => Promise<object>} [options.onCancel] - `POST /cancel`.
   * @param {object} [options.files] - FileStore контракта.
   * @param {object} [options.routeConfig] - `{ botId, chatId }` настроенного ассистента.
   * @param {boolean} [options.contractV2] - включён ли контракт v2.
   * @param {number} [options.maxFileBytes] - предел загружаемого файла.
   * @param {string} [options.host] - bind address, loopback by default.
   * @param {number} [options.port] - bind port.
   * @param {number} [options.maxBytes] - JSON body cap.
   * @param {number} [options.maxTaskChars] - task length cap.
   * @param {object} [options.logger] - logger.
   */
  constructor({
    token,
    onSubmit,
    onSubmitV2,
    getTask,
    onReply,
    onCancel,
    files,
    routeConfig = {},
    contractV2 = false,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    host = '127.0.0.1',
    port = 8787,
    maxBytes = DEFAULT_MAX_BYTES,
    maxTaskChars = DEFAULT_MAX_TASK_CHARS,
    logger,
  } = {}) {
    this.token = token
    this.onSubmit = onSubmit
    this.onSubmitV2 = onSubmitV2
    this.getTask = getTask
    this.onReply = onReply
    this.onCancel = onCancel
    this.files = files
    this.routeConfig = routeConfig
    this.contractV2 = Boolean(contractV2)
    this.maxFileBytes = Number(maxFileBytes) > 0 ? Number(maxFileBytes) : DEFAULT_MAX_FILE_BYTES
    this.host = host
    this.port = port
    this.maxBytes = maxBytes
    this.maxTaskChars = maxTaskChars
    this.logger = logger
    this.server = undefined
    this.address = undefined
  }

  /** True when the bridge has everything it needs. */
  get enabled() {
    return Boolean(this.token && (this.onSubmit || this.onSubmitV2))
  }

  /** Start listening; resolves once the port is bound. */
  async start() {
    if (!this.enabled) return undefined
    this.server = http.createServer((request, response) => {
      void this.handle(request, response)
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, this.host, resolve)
    })
    this.address = this.server.address()
    this.logger?.info('bridge listening', { host: this.host, port: this.address?.port, contractV2: this.contractV2 })
    return this.address
  }

  /** Stop listening. */
  async stop() {
    if (!this.server) return
    await new Promise((resolve) => this.server.close(resolve))
    this.server = undefined
  }

  /** One request: authenticate, route, answer. */
  async handle(request, response) {
    const send = (status, payload) => {
      const body = `${JSON.stringify(payload)}\n`
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(body)
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    if (request.method === 'GET' && (pathname === '/health' || pathname === '/v1/health')) {
      // No secret needed: the tunnel only exposes loopback, and a health probe
      // must work without one. It reveals nothing but "alive".
      send(200, { ok: true, service: 'agent-bridge', contract: 2 })
      return
    }

    const known = pathname === '/bridge' || pathname === '/v1/files' || pathname.startsWith('/v1/files/')
      || pathname === '/v1/tasks' || pathname.startsWith('/v1/tasks/') || pathname === '/v1/capabilities'
    if (!known) {
      send(404, { ok: false, error: 'not found' })
      return
    }

    const header = String(request.headers.authorization ?? '')
    const received = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!sameSecret(this.token, received)) {
      this.logger?.warn('bridge request rejected', { remote: request.socket?.remoteAddress })
      send(401, { ok: false, error: 'unauthorized' })
      return
    }

    try {
      if (request.method === 'GET' && pathname === '/v1/capabilities') {
        send(200, {
          ok: true,
          contract: 2,
          tasks: Boolean(this.onSubmitV2),
          files: Boolean(this.files),
          reply: Boolean(this.onReply),
          cancel: Boolean(this.onCancel),
          revision: Boolean(this.onSubmitV2),
          events: true,
          serviceEvents: true,
        })
        return
      }
      if (request.method === 'POST' && pathname === '/bridge') {
        await this.#legacy(request, send)
        return
      }
      if (request.method === 'POST' && pathname === '/v1/files') {
        await this.#upload(request, send)
        return
      }
      const fileId = parseFileId(pathname)
      if (request.method === 'GET' && fileId) {
        await this.#download(fileId, response, send)
        return
      }
      if (request.method === 'POST' && pathname === '/v1/tasks') {
        await this.#submitV2(request, send)
        return
      }
      const taskMatch = pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/(reply|cancel))?$/)
      if (taskMatch) {
        const [, taskId, action] = taskMatch
        if (request.method === 'GET' && !action) {
          const task = this.getTask?.(decodeURIComponent(taskId))
          if (!task) return send(404, { ok: false, error: 'task not found' })
          return send(200, { ok: true, contract: 2, task })
        }
        if (request.method === 'POST' && action === 'reply') {
          const body = await this.#json(request)
          const parsed = parseReplyRequest(body)
          const result = await this.onReply?.(decodeURIComponent(taskId), parsed)
          if (!result) return send(404, { ok: false, error: 'task not found' })
          return send(202, { ok: true, contract: 2, taskId: result.taskId ?? taskId, state: result.state ?? 'queued' })
        }
        if (request.method === 'POST' && action === 'cancel') {
          const body = await this.#json(request)
          const parsed = parseCancelRequest(body)
          const result = await this.onCancel?.(decodeURIComponent(taskId), parsed)
          if (!result) return send(404, { ok: false, error: 'task not found' })
          return send(200, { ok: true, contract: 2, taskId: result.taskId ?? taskId, state: result.state ?? 'cancelled' })
        }
      }
      send(404, { ok: false, error: 'not found' })
    } catch (error) {
      const status = statusOf(error)
      if (status >= 500) this.logger?.error('bridge request failed', { path: pathname, error })
      else this.logger?.warn('bridge request rejected', { path: pathname, status, error: error?.message })
      send(status, { ok: false, error: String(error?.message ?? error).slice(0, 200) })
    }
  }

  /** Read and parse a JSON body with the JSON cap. */
  async #json(request) {
    let raw
    try {
      raw = await readBody(request, this.maxBytes)
    } catch (error) {
      throw new ProtocolError(error?.code === 'TOO_LARGE' ? 413 : 400, 'bad body')
    }
    try {
      return JSON.parse(raw.toString('utf8'))
    } catch {
      throw new ProtocolError(400, 'bad json')
    }
  }

  /** Прежний `/bridge`: task/source и необязательный requestId. */
  async #legacy(request, send) {
    const payload = await this.#json(request)
    const task = String(payload?.task ?? '').trim()
    if (task === '') return send(400, { ok: false, error: 'empty task' })
    if (task.length > this.maxTaskChars) return send(400, { ok: false, error: `task longer than ${this.maxTaskChars} chars` })
    const requestId = payload?.requestId === undefined || payload?.requestId === null ? undefined : String(payload.requestId).trim()
    if (requestId !== undefined && (requestId === '' || requestId.length > 200)) {
      return send(400, { ok: false, error: 'requestId must be 1..200 chars' })
    }
    try {
      const result = await this.onSubmit({ task, source: payload?.source, requestId })
      this.logger?.info('bridge task accepted', {
        taskId: result?.taskId,
        chars: task.length,
        source: payload?.source,
        duplicate: Boolean(result?.duplicate),
      })
      return send(202, { ok: true, taskId: result?.taskId, state: result?.state ?? 'queued', duplicate: Boolean(result?.duplicate) })
    } catch (error) {
      const status = statusOf(error)
      this.logger?.error('bridge task rejected', { error, status })
      return send(status, { ok: false, error: String(error?.message ?? error).slice(0, 200) })
    }
  }

  /** `POST /v1/tasks`. */
  async #submitV2(request, send) {
    if (!this.contractV2 || !this.onSubmitV2) throw new ProtocolError(404, 'contract v2 disabled')
    const payload = await this.#json(request)
    const parsed = parseTaskRequest(payload, {
      maxTaskChars: this.maxTaskChars,
      routeConfig: this.routeConfig,
      fileExists: (fileId) => Boolean(this.files?.get(fileId)),
    })
    const result = await this.onSubmitV2(parsed)
    this.logger?.info('v2 task accepted', {
      taskId: result?.taskId,
      duplicate: Boolean(result?.duplicate),
      route: parsed.route ? 'assistant' : 'personal',
      files: parsed.attachments.length,
    })
    return send(202, {
      ok: true,
      contract: 2,
      taskId: result?.taskId,
      state: result?.state ?? 'queued',
      duplicate: Boolean(result?.duplicate),
    })
  }

  /** `POST /v1/files` — один файл в поле `file`. */
  async #upload(request, send) {
    if (!this.files) throw new ProtocolError(404, 'files disabled')
    let body
    try {
      body = await readBody(request, this.maxFileBytes + MULTIPART_OVERHEAD)
    } catch (error) {
      throw new ProtocolError(error?.code === 'TOO_LARGE' ? 413 : 400, 'bad body')
    }
    const file = parseMultipartFile(body, request.headers['content-type'])
    if (file.data.length > this.maxFileBytes) throw new ProtocolError(413, `файл больше ${this.maxFileBytes} байт`)
    const free = await freeSpace(this.files.dir)
    if (free !== undefined && free < file.data.length + 64 * 1024 * 1024) {
      throw new ProtocolError(503, 'мало свободного места для файла')
    }
    const record = await this.files.create({ bytes: file.data, name: file.filename, mime: file.mime, direction: 'input' })
    this.logger?.info('contract file uploaded', { fileId: record.fileId, bytes: record.size, mime: record.mime })
    return send(201, { ok: true, ...fileMeta(record) })
  }

  /** `GET /v1/files/:id`. */
  async #download(fileId, response, send) {
    if (!this.files) throw new ProtocolError(404, 'files disabled')
    const result = await this.files.read(fileId)
    if (!result.ok) {
      if (result.error === 'expired') return send(410, { ok: false, error: 'file expired' })
      return send(404, { ok: false, error: 'file not found' })
    }
    const original = String(result.record.name ?? 'file')
    // HTTP-заголовок только ASCII: кириллицу отдаём через filename* (RFC 5987).
    const ascii = original.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file'
    const encoded = encodeURIComponent(original)
    response.writeHead(200, {
      'content-type': result.record.mime || 'application/octet-stream',
      'content-length': result.bytes.length,
      'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    })
    response.end(result.bytes)
  }
}

/** Build the bridge server. */
export const createBridgeServer = (options) => new BridgeServer(options)
