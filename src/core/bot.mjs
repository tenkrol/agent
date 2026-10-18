/**
 * The task agent: Telegram in, DSH in the workspace, results back out.
 *
 * The loop is deliberately simple, because everything expensive happens in a
 * child process:
 *
 *   - long polling keeps running while a task runs, so `/cancel`, `/status` and
 *     a queued follow-up are answered immediately;
 *   - tasks execute strictly one at a time (one DSH process, one 2-vCPU box,
 *     and LibreOffice alone wants ~300 MB);
 *   - every task is wrapped in its own timeout and its own abort controller, and
 *     cancelling kills the whole process group;
 *   - the answer goes out as text, then each new file in the workspace goes out
 *     as a document or a photo.
 *
 * Two things turn a one-shot executor into something you can talk to:
 *
 *   - **the dialogue protocol** (`reply-protocol.mjs`): the agent may stop with
 *     `ВОПРОС:` or offer `ВАРИАНТ N:`; the task then parks in
 *     `awaiting_reply`, its session is kept, and the answer continues the same
 *     run — variants arrive as inline buttons;
 *   - **the task journal** (`tasks.mjs`): every task keeps its id, status,
 *     tokens, dollar estimate and files, which is what `/tasks`, `/task`,
 *     `/retry` and `/usage` read.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { saveAttachments } from '../tools/inbox.mjs'
import { MEMORY_FILE } from '../storage/memory.mjs'
import { AlertState } from '../autonomy/alerts.mjs'
import { OBSERVATIONS_FILE, READY_DAYS, loadObservations, readiness, renderReport } from '../autonomy/observe.mjs'
import { formatDiskSize, joinPath } from '../integrations/yandex-disk.mjs'
import { buildTaskPrompt, describeAttachmentIssues } from '../execution/prompt.mjs'
import { mirrorToAssistant } from '../bot-link/index.mjs'
import { composeReportText, quickFooter, quickStatus, statusMarkdown } from '../delivery/index.mjs'
import { costOf, costOfDay, formatUsd } from '../storage/pricing.mjs'
import { needsExecutor } from '../execution/quick.mjs'
import { CronError, describeCron, nextRunAt, parseCron, parseScheduleAdd } from './schedule.mjs'
import { buildContinuation, parseReply, variantButtonLabel } from '../execution/reply-protocol.mjs'
import { STATUS, TERMINAL, describeTask } from '../storage/tasks.mjs'
import { bodyHash } from '../storage/requests.mjs'
import { redactSecrets } from '../secrets/guard.mjs'
import { createOrchestrator } from '../orchestration/orchestrator.mjs'
import { prepareTaskWorkspace } from '../execution/workspace.mjs'
import { createBudget, minLimit } from '../orchestration/budget.mjs'
import { createDshExecutor } from '../agents/dsh/index.mjs'
import { createTaskLifecycle } from '../orchestration/lifecycle-manager.mjs'
import { SqliteTaskQueue } from '../storage/sqlite-queue.mjs'
import { buildQuestionEvent, buildResultEvent } from '../bot-link/events.mjs'
import { dayKey } from '../storage/usage.mjs'
import {
  collectOutputs,
  directorySize,
  ensureInstructions,
  ensureWorkspace,
  formatSize,
  pruneReservedDirs,
  readDeliverable,
  snapshot,
} from '../execution/workspace.mjs'

/** How many tasks may wait behind the running one. */
const QUEUE_LIMIT = 3
/** Telegram renders photos sent through multipart up to this size. */
const PHOTO_SEND_LIMIT = 10 * 1024 * 1024
/** How often the same chat is told again that it is not allowed. */
const DENY_REPEAT_MS = 10 * 60 * 1000
/** Characters of dsh stderr shown to the owner when a task fails. */
const ERROR_TAIL_CHARS = 700
/** How much of the original request is kept in the journal (for `/retry`). */
const REQUEST_KEEP_CHARS = 4000
/** How often expired questions are swept. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000

/** Map the DSH usage shape onto the provider shape `usage.mjs` understands. */
export function toProviderUsage(usage = {}) {
  return {
    prompt_tokens: (Number(usage.inputTokens) || 0) + (Number(usage.cacheReadTokens) || 0) + (Number(usage.cacheWriteTokens) || 0),
    completion_tokens: Number(usage.outputTokens) || 0,
    cached_tokens: Number(usage.cacheReadTokens) || 0,
  }
}

/** Task words that mean real work: a plan is worth approving before the run. */
export const PLAN_SIGNALS = [
  'отчёт', 'отчет', 'презентац', 'исследован', 'проанализируй', 'собери', 'сайт',
  'приложен', 'проект', 'документ', 'таблиц', 'страниц', 'статья', 'курс', 'смет',
  'бизнес-план', 'дизайн', 'макет', 'переведи документ', 'настрой', 'автоматизируй',
]

/** The commands this bot answers, with a one-line description each. */
const COMMANDS = [
  ['/start', 'показать справку'],
  ['/help', 'показать справку'],
  ['/status', 'что сейчас выполняется и сколько израсходовано'],
  ['/cancel', 'остановить текущую задачу, снять вопрос и очистить очередь'],
  ['/new', 'начать новую беседу (сбросить контекст задачи)'],
  ['/tasks', 'последние задачи: статус, время, файлы'],
  ['/task', 'подробности одной задачи: /task <id>'],
  ['/retry', 'повторить задачу: /retry <id>'],
  ['/continue', 'продолжить прерванную задачу: /continue <id>'],
  ['/deliver', 'повторить доставку результата: /deliver <id>'],
  ['/usage', 'расход по дням в токенах и деньгах: /usage [дней]'],
  ['/memory', 'что агент запомнил о вас; /memory — список, /forget <номер> — убрать'],
  ['/disk', 'Яндекс.Диск: /disk — состояние и файлы, /disk get <путь>, /disk link <путь>'],
  ['/observe', 'этап 0: что видит наблюдатель, базовая линия и черновик порогов'],
  ['/alerts', 'этап 1: состояние автономии, дедуп и счётчики алертов'],
  ['/stop', 'остановить автономию: остаются только аварийные алерты'],
  ['/resume', 'снять остановку автономии'],
  ['/remember', 'добавить факт в память: /remember текст'],
  ['/schedule', 'расписания: /schedule add "0 9 * * 1-5" задача'],
  ['/procedure', 'личные процедуры: /procedure list|show|save|set|activate|run'],
  ['/files', 'последние файлы в рабочей папке'],
]

export class AgentBot {
  /**
   * @param {object} options - bot options.
   * @param {object} options.config - validated configuration.
   * @param {object} options.platform - Telegram adapter.
   * @param {object} options.runner - DSH task runner.
   * @param {object} options.usage - usage store.
   * @param {object} options.state - state store.
   * @param {object} options.journal - task journal.
   * @param {object} [options.vision] - vision client for incoming images.
   * @param {object} [options.ocr] - local OCR fallback for incoming images.
   * @param {object} [options.logger] - logger.
   * @param {string} [options.instructionsPath] - `AGENTS.md` template to install.
   * @param {() => Date} [options.now] - clock, injected by tests.
   */
  constructor({ config, platform, runner, orchestrator, usage, state, journal, actions, delivery, requests, files, verifier, procedures, schedules, vision, ocr, stt, tts, quick, memory, disk, logger, instructionsPath, mirror = mirrorToAssistant, now = () => new Date() }) {
    this.config = config
    this.platform = platform
    this.runner = runner
    // Оркестратор — единственный владелец цикла исполнение → проверка → исправление.
    this.orchestrator = orchestrator ?? createOrchestrator({
      // Адаптер читает this.runner на каждом запуске: тесты и переключение
      // исполнителя не должны требовать пересоздания бота.
      executors: [
        createDshExecutor({ runner: { run: (request) => this.runner.run(request) } }),
        {
          id: 'quick',
          capabilities: ['quick'],
          execute: async ({ task, signal }) => {
            const quick = await this.quick.answer({ task, memory: this.memory?.render() ?? '', signal })
            return {
              ok: quick.routed === 'quick',
              text: quick.text,
              usage: quick.usage,
              quick,
              durationMs: quick.durationMs,
              aborted: Boolean(signal?.aborted),
            }
          },
        },
      ],
      verifier,
      limits: {
        tokenLimit: config.limits.taskTokenBudget,
        maxSteps: config.limits.taskMaxSteps,
        timeLimitMs: config.limits.taskTimeoutMs,
      },
      logger,
    })
    this.usage = usage
    this.state = state
    this.journal = journal
    this.actions = actions
    this.delivery = delivery
    this.requests = requests
    this.files = files
    this.verifier = verifier
    this.procedures = procedures
    this.schedules = schedules
    this.vision = vision
    this.ocr = ocr
    this.stt = stt
    this.tts = tts
    this.quick = quick
    this.memory = memory
    this.disk = disk
    this.logger = logger
    this.mirror = mirror
    this.instructionsPath = instructionsPath
    this.now = now
    // Параллельные workers без изоляции workspace/runner/progress запрещены.
    if (Number(config.queue?.workers ?? 1) > 1 && !config.workspace?.perTask) {
      throw new Error('QUEUE_WORKERS>1 требует WORKSPACE_PER_TASK=true: иначе workspace не изолирован')
    }
    // Очередь, восстановление, awaiting и завершение принадлежат lifecycle.
    // SQLite включается только явно: по умолчанию остаётся проверенный JSONL.
    const queueStore = config.queue?.store === 'sqlite'
      ? new SqliteTaskQueue({
        file: config.queue.db || path.join(config.workspace.stateDir, 'queue.db'),
        logger,
        now: () => this.now().getTime(),
      })
      : undefined
    this.queueStore = queueStore
    this.lifecycle = createTaskLifecycle({ journal, stateStore: state, queueStore, now: () => this.now().getTime() })

    /** @type {Map<string, number>} last "access denied" notice per chat. */
    this.deniedAt = new Map()
    this.pollController = undefined
    this.stopping = false
    this.worker = Promise.resolve()
    this.lastSweepAt = 0
    this.lastScheduleAt = 0
    this.lastProgressAt = 0
    this.recovered = { pending: [], interrupted: [] }
  }

  get queue() {
    return this.lifecycle.snapshot().queue
  }

  /** Read-only snapshot for /status; AgentBot не меняет активный контроллер. */
  get running() {
    return this.lifecycle.snapshot().running
  }

  /** Принятые SQLite-результаты, не попавшие в доставку до падения. */
  async recoverAcceptedOutbox() {
    if (!this.queueStore || !this.delivery?.enqueue) return
    for (const row of this.queueStore.pendingOutbox()) {
      const payload = row.payload
      if (payload?.kind === 'personal') {
        await this.safeSend(payload.chatId, payload.text, { replyToMessageId: payload.replyToMessageId })
      } else if (payload?.event) {
        await this.delivery.enqueue(payload.event)
      } else {
        continue
      }
      this.queueStore.markOutboxEnqueued(row.event_id)
      this.logger?.info('accepted outbox re-enqueued', { eventId: row.event_id, taskId: row.task_id })
    }
  }

  /** Prepare directories, identity and the polling cursor. */
  async start() {
    const { dir } = this.config.workspace
    await ensureWorkspace(dir)
    if (this.instructionsPath) {
      const created = await ensureInstructions(dir, this.instructionsPath)
      this.logger?.info('workspace ready', { dir, instructionsCreated: created })
    }
    const removed = await pruneReservedDirs(dir, { retentionDays: this.config.workspace.retentionDays })
    if (removed > 0) this.logger?.info('old reserved files pruned', { removed })

    await this.journal?.load()
    await this.journal?.compact()
    // Принятые задачи и прерванные выполнения восстанавливаются до опроса Telegram:
    // владелец не должен видеть «пустой» агент, пока очередь ещё не поднята.
    await this.memory?.cleanupTasks?.(this.config.memory?.taskRetentionDays ?? 7)
    this.recovered = await this.recoverTasks()
    if (this.delivery?.store) {
      const recovered = await this.delivery.store.recoverSending()
      if (recovered > 0) this.logger?.info('delivery sending recovered', { count: recovered })
      this.delivery.start()
    }
    await this.recoverAcceptedOutbox()?.catch?.((error) => this.logger?.warn('outbox recovery failed', { error }))
    if (this.schedules && this.config.schedules.enabled) {
      await this.schedules.load()
      // A restart must not fire a burst of missed runs: the next occurrence is
      // recomputed from now, and the skipped ones are reported once.
      const missed = await this.schedules.refresh(this.now(), { graceMs: this.config.schedules.tickSec * 2000 })
      this.logger?.info('schedules ready', { count: this.schedules.all().length, missed })
      if (missed > 0) {
        await this.alert(`🕒 Сервис был недоступен: пропущено срабатываний по расписанию — ${missed}. Они не догоняются, следующее выполнение по графику.`)
      }
    }

    // On a first-ever start there is no cursor: discard whatever backlog
    // Telegram kept, so the agent does not execute messages from before it ran.
    const hasCursor = this.state.get('offset') !== undefined
    await this.platform.start({ dropPendingUpdates: !hasCursor })
    if (!hasCursor) await this.state.flush()
    this.logger?.info('agent started', {
      bot: this.platform.identity?.username,
      workspace: dir,
      dshHome: this.config.dsh.home,
      dailyTokenLimit: this.config.limits.dailyTokenLimit,
      taskTimeoutMs: this.config.limits.taskTimeoutMs,
      tasks: this.journal?.records.size ?? 0,
    })
    void this.notifyStartup()
    void this.sweepAwaiting({ announce: true })
    void this.announceRecovery()
    if (this.queue.length > 0) {
      this.worker = this.worker.then(() => this.drain()).catch((error) => {
        this.logger?.error('recovery worker failed', { error })
      })
    }
  }

  /**
   * Поднять очередь и разобраться с оборванными выполнениями.
   *
   * Задачи в `queued` возвращаются в очередь в прежнем порядке. Задачи, которые
   * выполнялись, помечаются `interrupted` и не запускаются сами: неизвестно, какие
   * внешние действия успели произойти. Для них сохраняются последние шаги и файлы,
   * появившиеся в рабочей папке после начала выполнения.
   */
  async recoverTasks() {
    const recovered = await this.lifecycle.recover({
      actions: this.actions,
      recordToJob: (record) => this.recordToJob(record),
      snapshot: () => snapshot(this.config.workspace.dir),
      workspaceDir: this.config.workspace.dir,
    })
    if (recovered.pending.length > 0 || recovered.interrupted.length > 0) {
      this.logger?.info('queue recovered', {
        queued: recovered.pending.length,
        interrupted: recovered.interrupted.length,
      })
    }
    return recovered
  }

  /** Собрать задание из записи журнала для повторного выполнения. */
  recordToJob(record) {
    return {
      id: record.id,
      chatId: record.chatId,
      userId: record.userId,
      text: record.text ?? record.request ?? '',
      attachments: record.attachments ?? [],
      replyToMessageId: record.replyToMessageId,
      bridgeFrom: record.bridgeFrom,
      viaVoice: record.viaVoice,
      brief: record.brief,
      variantsMode: record.variantsMode,
      freshSession: record.freshSession,
      scheduledFrom: record.scheduledFrom,
      retryOf: record.retryOf,
      sessionId: record.sessionId,
      procedure: record.procedure,
      route: record.route,
      forceDsh: record.forceDsh,
      facts: record.facts ?? [],
      rootTaskId: record.rootTaskId,
      resultVersion: record.resultVersion,
      revisionOf: record.revisionOf,
      revisionContext: record.revisionContext,
      resultFiles: record.resultFiles,
      resultSummary: record.resultSummary,
    }
  }

  /** Одно сообщение о восстановлении, без спама при рестарт-петле. */
  async announceRecovery() {
    if (!this.recovered || this.config.recovery?.notify === false) return
    const { pending, interrupted } = this.recovered
    if (pending.length === 0 && interrupted.length === 0) return
    const chatId = this.alertChatId()
    if (chatId === undefined) return
    const parts = []
    if (pending.length > 0) {
      parts.push(`🔄 Восстановил принятые задачи: ${pending.length} (${pending.map((record) => record.id).join(', ')}).`)
    }
    if (interrupted.length > 0) {
      parts.push(`⏸ Прервано перезапуском: ${interrupted.map((record) => record.id).join(', ')}. `
        + 'Автоматически не повторяю — продолжить: /continue <id>, начать заново: /retry <id>.')
    }
    await this.safeSend(chatId, parts.join('\n\n'))
  }

  /** Tell the owner the agent is up; a restart loop must not spam. */
  async notifyStartup() {
    const chatId = this.alertChatId()
    if (chatId === undefined) return
    const last = Number(this.state.get('startupNoticeAt')) || 0
    if (this.now().getTime() - last < 30 * 60 * 1000) return
    this.state.set('startupNoticeAt', this.now().getTime())
    this.state.set('startupNoticeChatId', chatId)
    await this.safeSend(chatId, this.helpText('Агент запущен и готов к работе.'))
  }

  /** Where system alerts go: the configured chat, else the first allowed user. */
  alertChatId() {
    const configured = this.config.alerts?.chatId
    if (configured) return configured
    const first = [...this.config.telegram.allowedUserIds][0]
    return first === undefined ? undefined : first
  }

  /** Stop polling, kill the running task and flush the stores. */
  async stop() {
    this.stopping = true
    this.pollController?.abort()
    this.running?.controller?.abort()
    await this.worker.catch(() => {})
    await this.platform.stop?.()
    this.delivery?.stop?.()
    await Promise.all([
      this.usage.flush(),
      this.state.flush(),
      this.journal?.flush(),
      this.actions?.flush(),
      this.requests?.flush?.(),
      this.delivery?.store?.flush?.(),
    ])
  }

  /** Poll until `stop()` is called. */
  async run() {
    this.pollController = new AbortController()
    let cursor = this.state.get('offset')
    while (!this.stopping) {
      let batch
      try {
        batch = await this.platform.getUpdates({
          cursor,
          timeoutSec: this.config.telegram.pollTimeoutSec,
          signal: this.pollController.signal,
        })
      } catch (error) {
        if (this.stopping || error?.name === 'AbortError' || this.pollController.signal.aborted) break
        this.logger?.error('getUpdates failed', { error })
        await sleep(3000)
        continue
      }
      if (batch.cursor !== undefined && batch.cursor !== cursor) {
        cursor = batch.cursor
        this.state.set('offset', cursor)
      }
      for (const update of batch.updates) {
        try {
          await this.handleUpdate(update)
        } catch (error) {
          this.logger?.error('update handling failed', { updateId: update?.id, error })
        }
      }
      if (this.now().getTime() - this.lastSweepAt > SWEEP_INTERVAL_MS) {
        this.lastSweepAt = this.now().getTime()
        void this.sweepAwaiting({ announce: true })
      }
      await this.tickSchedules()
    }
    this.logger?.info('polling stopped')
  }

  /** Route one normalised update. */
  async handleUpdate(update) {
    if (this.stopping) return
    if (update?.kind === 'callback') {
      if (update.from?.isBot || !this.isAllowed(update.from?.id)) return
      await this.handleCallback(update)
      return
    }
    if (update?.kind !== 'message') return
    if (!update.addressed) return

    // A bot is a task source only in the bridge group, where the chat bot in
    // Spain submits work on the owner's behalf. Everywhere else bots are noise.
    const fromBridge = this.isBridgeSource(update)
    // Group ids are needed to configure the bridge, so they are logged once per
    // message: the owner writes in the new group and reads the id from here.
    if (update.chat?.type !== 'private') {
      this.logger?.info('group update', { chatId: update.chat?.id, fromBot: Boolean(update.from?.isBot), bridge: fromBridge })
    }
    if (update.from?.isBot && !fromBridge) return

    if (!fromBridge && !this.isAllowed(update.from?.id)) {
      this.logger?.warn('access denied', { userId: update.from?.id, chatId: update.chat?.id })
      const key = String(update.chat?.id)
      const last = this.deniedAt.get(key) ?? 0
      if (this.now().getTime() - last > DENY_REPEAT_MS) {
        this.deniedAt.set(key, this.now().getTime())
        await this.safeSend(update.chat.id, this.config.telegram.denyMessage.replace('{id}', String(update.from?.id ?? '')))
      }
      return
    }

    const chatId = update.chat.id
    const text = update.text ?? ''
    if (text.startsWith('/')) {
      const [rawName, ...rest] = text.split(/\s+/)
      const name = rawName.split('@')[0].toLowerCase()
      await this.handleCommand({ name, args: rest.join(' '), update })
      return
    }

    // While a question is open, a plain message is the answer to it.
    const awaiting = this.awaitingFor(chatId)
    if (awaiting) {
      if (this.isAwaitingExpired(awaiting)) {
        await this.expireAwaiting(chatId, awaiting)
        await this.safeSend(chatId, '🕓 Это был ответ на прошлый вопрос, но время ожидания истекло. Считаю сообщение новой задачей.')
      } else {
        await this.answerAwaiting({ awaiting, update, text })
        return
      }
    }

    if (text === '' && (update.attachments ?? []).length === 0) return
    await this.enqueue({ update, text })
  }

  /**
   * True when this update is the chat bot submitting a task through the bridge.
   *
   * The group has to be the configured one and the message has to be addressed
   * to this agent (a mention or a reply), so a stray message in the group never
   * becomes a task. When `BRIDGE_SOURCE_BOT_IDS` is set, only those bots count.
   */
  isBridgeSource(update) {
    const groupId = this.config.bridge?.groupId
    if (!groupId || update?.kind !== 'message') return false
    if (!update.from?.isBot || !update.addressed) return false
    if (String(update.chat?.id) !== String(groupId)) return false
    const allowed = this.config.bridge.sourceBotIds
    return allowed.size === 0 || allowed.has(String(update.from.id))
  }

  /** True when the user may talk to the agent. */
  isAllowed(userId) {
    if (this.config.telegram.allowAllUsers) return true
    return this.config.telegram.allowedUserIds.has(String(userId))
  }

  // ─── dialogue: questions and variants ──────────────────────────────────────

  /** The question a chat is currently expected to answer. */
  awaitingFor(chatId) {
    return this.lifecycle.awaitingFor(chatId)
  }

  /** Remember that a chat owes an answer, and to which task. */
  async setAwaiting(chatId, payload) {
    await this.lifecycle.setAwaiting(chatId, payload)
  }

  /** Forget the open question of a chat. */
  async clearAwaiting(chatId) {
    await this.lifecycle.clearAwaiting(chatId)
  }

  /** True when a question has been waiting longer than configured. */
  isAwaitingExpired(awaiting) {
    if (!awaiting?.askedAt) return false
    return this.now().getTime() - awaiting.askedAt > this.config.dialogue.awaitReplyMs
  }

  /** Close expired questions: the task is dropped, the user is told. */
  async sweepAwaiting({ announce = false } = {}) {
    if (!this.journal) return 0
    let expired = 0
    for (const [key, value] of this.state.entries()) {
      if (!key.startsWith('await:')) continue
      if (!this.isAwaitingExpired(value)) continue
      const chatId = key.slice('await:'.length)
      await this.expireAwaiting(chatId, value)
      if (announce) {
        await this.safeSend(chatId, `🕓 Задача ${value.taskId} закрыта: ответа на вопрос не было ${Math.round(this.config.dialogue.awaitReplyMs / 3600000)} ч. Файлы остались в рабочей папке; повторить — /retry ${value.taskId}.`)
      }
      expired += 1
    }
    return expired
  }

  /** Mark one awaiting task as expired and forget it. */
  async expireAwaiting(chatId, awaiting) {
    await this.lifecycle.update(awaiting.taskId, {
      status: STATUS.cancelled,
      reason: 'expired',
      error: 'ответа не дождался',
    }).catch(() => {})
    await this.clearAwaiting(chatId)
    this.logger?.info('question expired', { taskId: awaiting.taskId, chatId })
  }

  /** Treat a plain message as the answer to an open question. */
  async answerAwaiting({ awaiting, update, text }) {
    const chatId = update.chat.id
    const chosen = awaiting.kind === 'variant' ? matchVariant(text, awaiting.variants) : undefined
    if (awaiting.kind === 'variant' && !chosen && text.trim() !== '') {
      // Words instead of a number: the model usually asks a clarifying question
      // alongside the variants, so this is an answer to that, not "variant 1".
      await this.continueTask({
        awaiting,
        chatId,
        userId: update.from?.id,
        replyToMessageId: update.messageId,
        continuation: buildContinuation({ kind: 'question', text }),
      })
      return
    }
    await this.continueTask({
      awaiting,
      chatId,
      userId: update.from?.id,
      replyToMessageId: update.messageId,
      continuation: chosen
        ? buildContinuation({ kind: 'variant', variant: chosen.text })
        : buildContinuation({ kind: 'question', text }),
    })
  }

  /** Queue the next run of a parked task, keeping its session. */
  async continueTask({ awaiting, chatId, userId, replyToMessageId, continuation }) {
    await this.clearAwaiting(chatId)
    await this.enqueueJob({
      id: awaiting.taskId,
      chatId,
      userId,
      text: continuation,
      attachments: [],
      replyToMessageId,
      continuationOf: awaiting.taskId,
      sessionId: awaiting.sessionId,
      brief: awaiting.brief,
    })
  }

  /** A tap on a variant button, or on "cancel". */
  async handleCallback(update) {
    const chatId = update.chat.id
    const { data, id: callbackId, messageId } = update.callback
    const [action, taskId, rawVariant] = String(data).split(':')
    const awaiting = this.awaitingFor(chatId)

    if (!awaiting || awaiting.taskId !== taskId) {
      await this.safeAnswerCallback({ callbackId, text: 'Этот выбор уже неактуален.', alert: true })
      return
    }
    if (this.isAwaitingExpired(awaiting)) {
      await this.expireAwaiting(chatId, awaiting)
      await this.safeAnswerCallback({ callbackId, text: 'Время ожидания истекло.', alert: true })
      return
    }

    if (action === 'p' && awaiting.kind === 'plan') {
      await this.safeAnswerCallback({ callbackId, text: 'Выполняю по плану' })
      await this.dropKeyboard({ chatId, messageId, markdown: `${update.callback.text}\n\n✅ План утверждён.` })
      await this.approvePlan({ awaiting, chatId, userId: update.from?.id, replyToMessageId: messageId })
      return
    }

    if (action === 'x') {
      await this.clearAwaiting(chatId)
      await this.lifecycle.finishTask(taskId, { status: STATUS.cancelled, reason: 'cancelled', error: 'отменено пользователем' })
      await this.safeAnswerCallback({ callbackId, text: 'Отменено' })
      await this.dropKeyboard({ chatId, messageId, markdown: `${update.callback.text}\n\n⛔ Отменено.` })
      return
    }

    const variant = (awaiting.variants ?? []).find((item) => String(item.n) === String(rawVariant))
    if (!variant) {
      await this.safeAnswerCallback({ callbackId, text: 'Такого варианта нет.', alert: true })
      return
    }

    await this.safeAnswerCallback({ callbackId, text: `Вариант ${variant.n}` })
    await this.dropKeyboard({ chatId, messageId, markdown: `${update.callback.text}\n\n✅ Выбран вариант ${variant.n}.` })
    await this.continueTask({
      awaiting,
      chatId,
      userId: update.from?.id,
      replyToMessageId: messageId,
      continuation: buildContinuation({ kind: 'variant', variant: variant.text }),
    })
  }

  /** Replace a message with one that has no buttons left. */
  async dropKeyboard({ chatId, messageId, markdown }) {
    if (!messageId) return
    try {
      await this.platform.editText({ chatId, messageId, markdown })
    } catch (error) {
      this.logger?.debug('keyboard removal failed', { error })
    }
  }

  /** Answer a tap without letting a Telegram failure break the flow. */
  async safeAnswerCallback({ callbackId, text, alert = false }) {
    try {
      return await this.platform.answerCallback({ callbackId, text, alert })
    } catch (error) {
      this.logger?.debug('answerCallback failed', { error })
      return undefined
    }
  }

  // ─── commands ─────────────────────────────────────────────────────────────

  /** Handle one slash command. */
  async handleCommand({ name, args, update }) {
    const chatId = update.chat.id
    switch (name) {
      case '/start':
      case '/help':
        await this.safeSend(chatId, this.helpText())
        return
      case '/status':
        await this.safeSend(chatId, this.statusText(chatId))
        return
      case '/cancel':
        await this.cancelAll(chatId)
        return
      case '/new':
        await this.clearAwaiting(chatId)
        this.state.delete(`session:${chatId}`)
        await this.clearQueue('очищено командой /new')
        await this.safeSend(chatId, '🆕 Контекст сброшен: следующая задача начнётся с чистого листа.')
        return
      case '/tasks':
        await this.safeSend(chatId, this.tasksText(args))
        return
      case '/task':
        await this.safeSend(chatId, this.taskText(args))
        return
      case '/retry':
        await this.safeSend(chatId, await this.retryTask({ args, chatId, userId: update.from?.id, replyToMessageId: update.messageId }))
        return
      case '/continue':
        await this.safeSend(chatId, await this.continueInterrupted({ args }))
        return
      case '/deliver':
        await this.safeSend(chatId, await this.deliverAgain(args))
        return
      case '/usage':
        await this.safeSend(chatId, this.usageText(args))
        return
      case '/schedule':
        await this.safeSend(chatId, await this.scheduleCommand({ args, update }))
        return
      case '/procedure':
        await this.safeSend(chatId, await this.procedureCommand({ args }))
        return
      case '/files':
        await this.safeSend(chatId, await this.filesText())
        return
      case '/disk':
        await this.safeSend(chatId, await this.diskText(args))
        return
      case '/observe':
        await this.safeSend(chatId, await this.observeText(args))
        return
      case '/stop':
        await this.safeSend(chatId, await this.stopAlerts())
        return
      case '/resume':
        await this.safeSend(chatId, await this.resumeAlerts())
        return
      case '/alerts':
        await this.safeSend(chatId, await this.alertsText())
        return
      case '/memory':
        await this.safeSend(chatId, await this.memoryCommand(args))
        return
      case '/remember':
        await this.safeSend(chatId, await this.rememberText(args))
        return
      case '/forget':
        await this.safeSend(chatId, await this.forgetText(args))
        return
      default:
        if (args === '' && name.length > 1) {
          await this.safeSend(chatId, `Неизвестная команда ${name}.\n\n${this.helpText()}`)
        }
    }
  }

  /** Human-readable help, with the current limits. */
  helpText(prefix = '') {
    const minutes = Math.round(this.config.limits.taskTimeoutMs / 60000)
    const lines = [
      prefix,
      'Я агент-исполнитель: пишите задачу обычным сообщением, я спланирую шаги, поработаю с файлами и кодом и пришлю результат — текстом и файлами.',
      '',
      '• Файлы принимаю как вложения (PDF, DOCX, XLSX, PPTX, CSV, код) — текст из них извлекается.',
      '• Фото, скриншоты и сканы распознаю: приходит текст и описание изображения.',
      '• Готовые документы, таблицы, презентации и картинки верну вложением.',
      '• Если данных не хватает — задам вопрос; если путей несколько — предложу варианты кнопками.',
      '• Умею выполнять задачу по расписанию: /schedule add "0 9 * * 1-5" собери сводку',
      '• Финальный ответ коротко: что сделано и где лежит результат.',
      '',
      `Ограничения: до ${minutes} мин на задачу, ${Math.round(this.config.limits.dailyTokenLimit / 1000)} тыс. токенов в сутки.`,
      '',
      'Команды:',
      ...COMMANDS.map(([command, description]) => `• ${command} — ${description}`),
    ]
    return lines.filter((line) => line !== undefined).join('\n')
  }

  /** Current state: running task, queue, today's spend. */
  statusText(chatId) {
    const lines = []
    if (this.running) {
      const elapsedMin = Math.round((this.now().getTime() - this.running.startedAt) / 60000)
      lines.push(`⏳ Выполняется задача ${this.running.id} (${elapsedMin} мин, шагов: ${this.running.steps}).`)
    } else {
      lines.push('💤 Сейчас ничего не выполняется.')
    }
    if (this.queue.length > 0) lines.push(`В очереди: ${this.queue.length}.`)
    const awaiting = this.awaitingFor(chatId)
    if (awaiting) lines.push(`❓ Задача ${awaiting.taskId} ждёт вашего ответа (${awaiting.kind === 'variant' ? 'выбор варианта' : 'уточнение'}).`)
    lines.push(this.spendLine())
    if (this.state.get(`session:${chatId}`)) lines.push('Контекст беседы: сохраняется (сбросить — /new).')
    return lines.join('\n')
  }

  /** One line about today's budget. */
  spendLine() {
    const timeZone = this.config.runtime.timeZone
    const spent = this.usage.tokens(this.now(), timeZone)
    const limit = this.config.limits.dailyTokenLimit
    const cost = costOfDay(this.usage.total(this.now(), timeZone), this.pricingOptions())
    if (limit > 0) {
      const percent = Math.round((spent / limit) * 100)
      return `Сегодня: ${spent.toLocaleString('ru-RU')} из ${limit.toLocaleString('ru-RU')} токенов (${percent}%), ≈${formatUsd(cost.usd)} (кэш учтён по своей цене).`
    }
    return `Сегодня: ${spent.toLocaleString('ru-RU')} токенов, ≈${formatUsd(cost.usd)}.`
  }

  /** Pricing options from the configuration. */
  pricingOptions(date = this.now()) {
    return {
      date,
      prices: this.config.pricing.prices,
      windows: this.config.pricing.windows,
      weekdaysOnly: this.config.pricing.weekdaysOnly,
    }
  }

  /** The last few tasks with their outcome. */
  tasksText(args = '') {
    if (!this.journal) return 'Журнал задач недоступен.'
    const limit = clamp(Number.parseInt(String(args).trim(), 10) || 10, 1, 30)
    const records = this.journal.recent(limit)
    if (records.length === 0) return 'Задач пока не было.'
    const awaiting = records.filter((record) => record.status === STATUS.awaiting)
    const header = `Последние ${records.length} задач:`
    const footer = awaiting.length > 0
      ? `\n❓ Ждут ответа: ${awaiting.map((record) => record.id).join(', ')} — ответьте сообщением или /cancel.`
      : ''
    return [header, '', ...records.map((record) => describeTask(record)), footer].filter(Boolean).join('\n')
  }

  /** Everything known about one task. */
  taskText(args = '') {
    if (!this.journal) return 'Журнал задач недоступен.'
    const id = String(args).trim().split(/\s+/)[0]
    if (id === '') return 'Укажите id: /task <id>. Список — /tasks.'
    const record = this.journal.get(id)
    if (!record) return `Задача ${id} не найдена. Список — /tasks.`
    const lines = [describeTask(record)]
    if (record.request) lines.push('', `Запрос: ${String(record.request).slice(0, 400)}`)
    if (record.question) lines.push('', `Вопрос к вам: ${record.question}`)
    if (Array.isArray(record.variants) && record.variants.length > 0) {
      lines.push('', 'Варианты:', ...record.variants.map((variant) => `• ${variant.n}. ${String(variant.text).slice(0, 200)}`))
    }
    if (record.tokens) {
      lines.push('', `Токены: вход ${record.tokens.uncachedInput.toLocaleString('ru-RU')}, кэш ${record.tokens.cachedInput.toLocaleString('ru-RU')}, выход ${record.tokens.output.toLocaleString('ru-RU')}`)
    }
    if (record.usd !== undefined) lines.push(`Оценка стоимости: ${formatUsd(record.usd)}${record.peak ? ' (пик)' : ''}`)
    return lines.join('\n')
  }

  /** Re-run a finished task from its stored request. */
  async retryTask({ args, chatId, userId, replyToMessageId }) {
    if (!this.journal) return 'Журнал задач недоступен.'
    const id = String(args).trim().split(/\s+/)[0]
    if (id === '') return 'Укажите id: /retry <id>. Список — /tasks.'
    const record = this.journal.get(id)
    if (!record) return `Задача ${id} не найдена.`
    if ([STATUS.running, STATUS.awaiting_owner, STATUS.queued, STATUS.verifying].includes(record.status)) {
      return `Задача ${id} ещё не завершена (${record.status}); дождитесь окончания или /cancel.`
    }
    const text = String(record.request ?? record.brief ?? '').trim()
    if (text === '') return `У задачи ${id} не сохранился текст запроса.`
    await this.enqueueJob({
      id: this.journal.nextId(this.now()),
      chatId,
      userId,
      text,
      attachments: [],
      replyToMessageId,
      brief: `повтор ${id}`,
      retryOf: id,
      // A retry means the quick answer was not wanted: go to the executor.
      forceDsh: true,
    })
    return `🔁 Повторяю задачу ${id} как новую.`
  }

  /** Spend per day, in tokens and in money. */
  usageText(args = '') {
    const timeZone = this.config.runtime.timeZone
    const days = clamp(Number.parseInt(String(args).trim(), 10) || 7, 1, 60)
    const today = this.now()
    const limit = this.config.limits.dailyTokenLimit
    const records = this.journal ? this.journal.recent(500) : []
    const forDay = (key) => records.filter((record) => dayKey(new Date(record.createdAt ?? 0), timeZone) === key)

    const lines = []
    let totalTokens = 0
    let totalUsd = 0
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const date = new Date(today.getTime() - offset * 24 * 3600 * 1000)
      const key = dayKey(date, timeZone)
      const day = this.usage.total(date, timeZone)
      // The journal knows every run together with its tariff, so the money is
      // summed from it; the usage store covers days the journal no longer keeps.
      const dated = forDay(key)
      if (day.requests === 0 && dated.length === 0) continue
      const tokens = (day.prompt + day.completion)
        || dated.reduce((sum, record) => sum + (record.tokens?.total ?? 0), 0)
      const cached = Number(day.cached)
        || dated.reduce((sum, record) => sum + (record.tokens?.cachedInput ?? 0), 0)
      const usd = dated.length > 0
        ? dated.reduce((sum, record) => sum + (record.usd ?? 0), 0)
        : costOfDay(day, this.pricingOptions(date)).usd
      totalTokens += tokens
      totalUsd += usd
      const share = tokens > 0 ? Math.round((cached / tokens) * 100) : 0
      lines.push(`• ${key} — ${tokens.toLocaleString('ru-RU')} токенов (кэш ${share}%), ≈${formatUsd(usd)}`)
    }

    const parts = [days === 1 ? '💰 Расход за сегодня:' : `💰 Расход за ${days} дн.:`]
    if (lines.length === 0) {
      parts.push('', 'За выбранный период расход не зафиксирован.')
    } else {
      parts.push('', ...lines, '', `Итого: ${totalTokens.toLocaleString('ru-RU')} токенов, ≈${formatUsd(totalUsd)}.`)
      const todayTokens = this.usage.tokens(today, timeZone)
      if (limit > 0) {
        parts.push(`Лимит на день: ${todayTokens.toLocaleString('ru-RU')} из ${limit.toLocaleString('ru-RU')} (${Math.round((todayTokens / limit) * 100)}%).`)
      }
      parts.push('Повторно отправленный контекст (кэш) стоит в 50 раз дешевле нового входа, поэтому счётчик токенов большой, а деньги — нет: смотрите на $.')
    }

    // What actually ate the budget: without this "большой расход" cannot be read.
    const heaviest = forDay(dayKey(today, timeZone))
      .filter((record) => (record.tokens?.total ?? 0) > 0)
      .sort((a, b) => (b.tokens?.total ?? 0) - (a.tokens?.total ?? 0))
      .slice(0, 3)
    if (heaviest.length > 0) {
      parts.push('', 'Самые дорогие задачи сегодня:')
      for (const record of heaviest) {
        parts.push(`• ${record.id} — ${record.tokens.total.toLocaleString('ru-RU')} токенов, ${record.steps ?? '?'} шаг(ов), ≈${formatUsd(record.usd ?? 0)}: «${String(record.brief ?? '').slice(0, 40)}»`)
      }
    }

    parts.push('', this.spendLine())
    if (this.journal) {
      const todayKey = dayKey(today, timeZone)
      const todayTasks = forDay(todayKey)
      const done = todayTasks.filter((record) => record.status === STATUS.done).length
      const failed = todayTasks.filter((record) => [STATUS.failed, STATUS.timeout].includes(record.status)).length
      parts.push(`Сегодня задач: ${todayTasks.length}, из них успешных ${done}, с ошибкой ${failed}.`)
    }
    return parts.join('\n')
  }

  /**
   * Pick up durable facts the agent appended to `memory.md`.
   *
   * The file lives in the workspace (the only place a task may write), so it is
   * read after the run and deleted: the store in the state directory is the
   * single source of truth from then on.
   */
  async ingestMemory({ job, dir }) {
    if (!this.memory) return
    const file = path.join(dir, MEMORY_FILE)
    let content
    try {
      content = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn('memory file unreadable', { error })
      return
    }
    try {
      const added = await this.memory.ingest(content, { source: job.id, now: this.now })
      if (added.length > 0) {
        this.logger?.info('facts remembered', { taskId: job.id, count: added.length, total: this.memory.size })
      }
    } catch (error) {
      this.logger?.warn('memory ingest failed', { error })
    }
    await fs.rm(file, { force: true }).catch(() => {})
  }

  /**
   * Keep the deliverables on Yandex.Disk as well.
   *
   * Telegram is the delivery channel, Disk is the archive: a task that made a
   * report should leave a copy that is findable in a month. A failure here is
   * logged and reported but never turns a finished task into a failed one.
   */
  async uploadToDisk({ job, outputs, silent = false }) {
    if (!this.disk?.enabled) return []
    const files = outputs?.selected ?? []
    if (files.length === 0) return []
    const folder = joinPath(this.disk.dir, job.id)
    const uploaded = []
    for (const file of files) {
      let bytes
      try {
        bytes = await fs.readFile(path.join(this.config.workspace.dir, file.relPath))
      } catch (error) {
        this.logger?.warn('disk upload skipped, file unreadable', { file: file.relPath, error })
        continue
      }
      const target = joinPath(folder, path.basename(file.relPath))
      const result = await this.disk.upload({ path: target, bytes })
      if (result.ok) uploaded.push({ relPath: file.relPath, remote: target, size: file.size })
      else this.logger?.warn('disk upload failed', { file: file.relPath, error: result.error })
    }
    if (uploaded.length === 0) return []

    await this.lifecycle.update(job.id, { disk: uploaded.map((item) => item.remote) })
    if (silent) {
      // Пути попадут в единственный итоговый отчёт, отдельного сообщения не нужно.
      this.logger?.info('deliverables stored on disk', { taskId: job.id, count: uploaded.length, folder })
      return uploaded.map((item) => item.remote)
    }
    let link = ''
    if (this.config.disk.publish) {
      const published = await this.disk.publish(uploaded[0].remote)
      if (published.ok && published.url) link = `\nСсылка: ${published.url}`
    }
    await this.safeSend(job.chatId, [
      `📁 Файлы задачи ${job.id} лежат на Яндекс.Диске:`,
      ...uploaded.map((item) => `• ${item.remote}`),
      link,
    ].filter((part) => part !== '').join('\n'), { replyToMessageId: this.jobReplyTo(job) })
    this.logger?.info('deliverables stored on disk', { taskId: job.id, count: uploaded.length, folder })
    return uploaded.map((item) => item.remote)
  }

  /** `/disk` — state, recent files, and the two actions worth having. */
  async diskText(args = '') {
    if (!this.disk?.enabled) {
      return [
        '☁️ Яндекс.Диск не подключён.',
        '',
        'Чтобы включить: получить OAuth-токен приложения с доступом к Диску и прописать его на сервере:',
        '`YANDEX_DISK=true` и `YANDEX_DISK_TOKEN=…` (см. README, раздел «Яндекс.Диск»).',
      ].join('\n')
    }
    const [action, ...rest] = String(args ?? '').trim().split(/\s+/)
    const target = rest.join(' ').trim()

    if (action === 'get') {
      if (target === '') return 'Укажите путь: /disk get /Агент/212558-ecs/most.txt'
      const downloaded = await this.disk.download(target)
      if (!downloaded.ok) return `Не удалось скачать: ${downloaded.error}`
      const name = path.basename(target) || 'file'
      const dir = path.join(this.config.workspace.dir, 'inbox')
      await fs.mkdir(dir, { recursive: true })
      const local = path.join(dir, name)
      await fs.writeFile(local, downloaded.bytes)
      return [
        `⬇️ Скачал с Диска: ${target}`,
        `Файл в рабочей папке: \`inbox/${name}\` (${formatDiskSize(downloaded.bytes.length)}).`,
        'Теперь его можно указать в задаче, например: «разбери inbox/' + name + '».',
      ].join('\n')
    }

    if (action === 'link') {
      if (target === '') return 'Укажите путь: /disk link /Агент/212558-ecs/most.txt'
      const published = await this.disk.publish(target)
      if (!published.ok) return `Не удалось опубликовать: ${published.error}`
      return `🔗 Публичная ссылка (доступна любому, у кого она есть):\n${published.url}`
    }

    const probe = await this.disk.probe()
    if (!probe.ok) return `☁️ Яндекс.Диск: ${probe.error}`
    const listing = await this.disk.list(this.disk.dir, { limit: 10 })
    const lines = [`☁️ Яндекс.Диск подключён. Папка: ${probe.dir}`]
    if (probe.quotaKnown === false) lines.push('Режим WebDAV: занятое место Диск здесь не показывает.')
    else lines.push(`Занято ${formatDiskSize(probe.used)} из ${formatDiskSize(probe.total)}.`)
    if (listing.ok && listing.items.length > 0) {
      lines.push('', 'Последнее в папке:')
      for (const item of listing.items) {
        lines.push(`• ${item.type === 'dir' ? '📁' : '📄'} ${item.path}${item.type === 'file' ? ` — ${formatDiskSize(item.size)}` : ''}`)
      }
    } else if (listing.ok) {
      lines.push('', 'Папка пока пуста: файлы появятся здесь после первой задачи с результатом.')
    }
    lines.push('', 'Скачать в работу: /disk get <путь>. Сделать ссылку: /disk link <путь>.')
    return lines.join('\n')
  }

  /** Состояние алертов: читаем с диска каждый раз — его пишет таймер. */
  async alertState() {
    return new AlertState({
      file: path.join(this.config.workspace.stateDir, 'alerts.json'),
      logger: this.logger,
    }).load()
  }

  /** `/stop` — постоянный режим «только алерты» (переживает перезапуск). */
  async stopAlerts() {
    const state = await this.alertState()
    await state.setStopped(true)
    return [
      '⏸ Автономия остановлена: предупреждения молчат, приходят только аварийные (сервис лежит, диск кончился).',
      'Снять — /resume. Задачи при этом работают как обычно.',
    ].join('\n')
  }

  /** `/resume` — вернуть предупреждения. */
  async resumeAlerts() {
    const state = await this.alertState()
    await state.setStopped(false)
    return '▶️ Автономия снова с предупреждениями: обычные алерты вернутся.'
  }

  /** `/alerts` — что происходит с автономией и сколько она уже сработала. */
  async alertsText() {
    const state = await this.alertState()
    const file = path.join(this.config.workspace.stateDir, OBSERVATIONS_FILE)
    const samples = await loadObservations(file)
    const ready = readiness(samples)
    const mode = this.config.alerts.mode
    const armed = mode === 'armed' || (mode === 'auto' && ready.ready)
    const counters = state.data.counters ?? {}
    const lines = [
      '🔔 Автономия (этап 1)',
      `Режим: ${mode}${armed ? ' — алерты включены' : ' — сухой прогон, ждём базовую линию'}`,
      `Остановка: ${state.stopped ? 'включена (/resume снимет)' : 'нет'}`,
      `Наблюдений: ${samples.length}, покрытие ${Math.round(ready.coverage * 100)}% (нужно ${ready.requiredDays} суток)`,
      `Отправлено алертов: ${counters.sent ?? 0}, подавлено дедупом: ${counters.dedup ?? 0}`,
      `Отложено в тихие часы: ${state.data.quiet.length}`,
      '',
      'Пороги: диск < ' + this.config.alerts.emergencyDiskMb + ' МБ (авария), < ' + this.config.alerts.warnDiskMb + ' МБ (предупреждение); '
        + 'статистические — после базовой линии. Тихие часы: ' + (this.config.alerts.quietHours || 'выключены') + '.',
    ]
    if (state.data.quiet.length > 0) {
      lines.push('', 'Отложенное:')
      for (const item of state.data.quiet.slice(-5)) lines.push(`• ${item.title}: ${item.detail}`)
    }
    return lines.join('\n')
  }

  /**
   * Этап 0 «Наблюдатель»: сводка по журналу метрик.
   *
   * Замеры снимает таймер без модели; здесь только чтение и расчёт базовой
   * линии, поэтому команда не тратит токенов.
   */
  async observeText(args = '') {
    const days = clamp(Number.parseInt(String(args).trim(), 10) || READY_DAYS, 1, 60)
    const file = path.join(this.config.workspace.stateDir, OBSERVATIONS_FILE)
    const samples = await loadObservations(file)
    this.logger?.info('observations report', { samples: samples.length, days })
    return renderReport({ samples, days, now: this.now() })
  }

  /** What the agent remembers about the owner. */
  async memoryText() {
    if (!this.memory || this.memory.size === 0) {
      return ['🧠 Память пуста.', '', 'Агент записывает факты сам, когда узнаёт что-то долговечное (город, предпочтения, названия проектов). Добавить вручную: /remember текст.'].join('\n')
    }
    const lines = this.memory.list().map((fact, index) => `${index + 1}. ${fact.text}`)
    return [`🧠 Память (${this.memory.size}):`, '', ...lines, '', 'Убрать факт: /forget <номер> или /forget <часть текста>.'].join('\n')
  }

  /** Add a fact by hand. */
  async rememberText(args) {
    let text = String(args ?? '').trim()
    if (!this.memory) return 'Память недоступна.'
    if (text === '') return 'Напишите факт: /remember живёт в Москве.'
    let kind = 'preference'
    let validUntil
    const until = text.match(/--until\s+(\d{4}-\d{2}-\d{2})/)
    if (until) {
      const end = new Date(`${until[1]}T23:59:59`)
      if (Number.isNaN(end.getTime())) return 'Дата --until должна быть вида YYYY-MM-DD.'
      validUntil = end.getTime()
      text = text.replace(until[0], '').trim()
    }
    const kindMatch = text.match(/--kind\s+(temporary|preference|task)/)
    if (kindMatch) {
      kind = kindMatch[1]
      text = text.replace(kindMatch[0], '').trim()
    }
    if (text === '') return 'Напишите факт: /remember живёт в Москве.'
    const fact = await this.memory.add(text, { source: 'owner', kind, validUntil })
    if (!fact) return `Уже помню: «${text}» (или факт отклонён как секрет).`
    return `🧠 Запомнил: «${fact.text}» (всего ${this.memory.size})${validUntil ? ', временно' : ''}.`
  }

  /** Drop a fact by its number or a fragment of its text. */
  async forgetText(args) {
    const reference = String(args ?? '').trim()
    if (!this.memory) return 'Память недоступна.'
    if (reference === '') {
      // No argument: show the list, so the owner can pick a number.
      return [`Укажите, что забыть: /forget <номер> или /forget <часть текста>.`, '', await this.memoryText()].join('\n')
    }
    const removed = await this.memory.forget(reference)
    if (!removed) return `Не нашёл в памяти «${reference}». Посмотреть список: /memory.`
    return `🧠 Забыл: «${removed.text}» (осталось ${this.memory.size}).`
  }

  /** Draft a plan for an unattended task and return it for the prompt. */
  async maybePlanUnattended({ job, controller, budget }) {
    if (!this.config.plan.unattended || !this.quick?.enabled) return ''
    if (!(job.scheduledFrom || job.bridgeFrom)) return ''
    if (job.planApproved || job.forceDsh) return ''
    if (!this.planWorth(job.text)) return ''
    const planningOwner = this.lifecycle.beginIfIdle({ id: job.id, chatId: job.chatId, controller, startedAt: this.now().getTime(), attemptId: `${job.id}-plan` })
    let drafted
    try {
      drafted = await this.quick.plan({ task: job.text, memory: this.memory?.render() ?? '', signal: controller?.signal })
    } finally {
      if (planningOwner) this.lifecycle.finish(job.id)
    }
    if (drafted.usage.totalTokens > 0) {
      this.usage.record({
        usage: toProviderUsage(drafted.usage),
        userId: job.userId,
        chatId: job.chatId,
        date: this.now(),
        timeZone: this.config.runtime.timeZone,
      })
    }
    budget?.consume(drafted.usage, { unknown: drafted.usage.totalTokens === undefined })
    if (controller?.signal.aborted) return ''
    if (drafted.plan === '') {
      this.logger?.info('unattended plan skipped', { taskId: job.id, error: drafted.error })
      return ''
    }
    this.logger?.info('unattended plan drafted', {
      taskId: job.id,
      tokens: drafted.usage.totalTokens,
      chars: drafted.plan.length,
    })
    return drafted.plan
  }

  /** Whether a task text looks big enough to be worth planning. */
  planWorth(text) {
    const value = String(text ?? '')
    if (value.length >= this.config.plan.minChars) return true
    const configured = this.config.plan.signals === ''
      ? PLAN_SIGNALS
      : this.config.plan.signals.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
    const lower = value.toLowerCase()
    return configured.some((signal) => lower.includes(signal))
  }

  /** Whether this task deserves a plan before it runs. */
  shouldPlan(job) {
    const mode = this.config.plan.mode
    if (mode === 'never') return false
    if (!this.quick?.enabled) return false
    if (job.forceDsh || job.planApproved || job.continuationOf) return false
    // Nobody is around to approve a plan for scheduled or bridged work.
    if (job.scheduledFrom || job.bridgeFrom) return false
    if (mode === 'always') return true
    return this.planWorth(job.text)
  }

  /**
   * Draft a plan, show it and wait for approval.
   *
   * @returns {Promise<object|undefined>} a marker when the task is parked, undefined to just run it.
   */
  async parkForPlan({ job, statusMessageId, controller, budget }) {
    if (!this.shouldPlan(job)) return undefined
    if (controller?.signal.aborted) {
      await this.lifecycle.finishTask(job.id, { status: STATUS.cancelled, reason: 'cancelled' })
      return { cancelled: true }
    }
    await this.markStatus({ chatId: job.chatId, statusMessageId, markdown: `📝 Задача ${job.id}: составляю план.` })
    const planningOwner = this.lifecycle.beginIfIdle({ id: job.id, chatId: job.chatId, controller, startedAt: this.now().getTime(), attemptId: `${job.id}-plan` })
    let drafted
    try {
      drafted = await this.quick.plan({ task: job.text, memory: this.memory?.render() ?? '', signal: controller?.signal })
    } finally {
      if (planningOwner) this.lifecycle.finish(job.id)
    }
    if (drafted.usage.totalTokens > 0) {
      this.usage.record({
        usage: toProviderUsage(drafted.usage),
        userId: job.userId,
        chatId: job.chatId,
        date: this.now(),
        timeZone: this.config.runtime.timeZone,
      })
    }
    budget?.consume(drafted.usage, { unknown: drafted.usage.totalTokens === undefined })
    if (controller?.signal.aborted) {
      await this.lifecycle.finishTask(job.id, { status: STATUS.cancelled, reason: 'cancelled' })
      return { cancelled: true }
    }
    // A planner that failed is not a reason to stop: the task just runs as before.
    if (drafted.plan === '') {
      this.logger?.info('plan skipped', { taskId: job.id, error: drafted.error })
      return undefined
    }

    await this.lifecycle.awaitAnswer({
      taskId: job.id,
      chatId: job.chatId,
      patch: { plan: drafted.plan.slice(0, 2000), askedAt: this.now().getTime() },
      awaiting: {
        kind: 'plan',
        plan: drafted.plan,
        originalText: String(job.text ?? ''),
        brief: job.brief ?? String(job.text ?? '').slice(0, 200),
      },
    })
    await this.markStatus({ chatId: job.chatId, statusMessageId, markdown: `📝 Задача ${job.id}: жду решения по плану.` })
    const sent = await this.safeSend(job.chatId, [
      `📝 План задачи ${job.id}:`,
      '',
      drafted.plan,
      '',
      '_Выполнять по этому плану? Кнопка ниже. Можно ответить текстом — правки уйдут исполнителю._',
    ].join('\n'), {
      keyboard: this.planKeyboard(job.id),
      replyToMessageId: this.jobReplyTo(job),
    })
    if (sent?.messageId !== undefined) {
      const awaiting = this.awaitingFor(job.chatId)
      if (awaiting) await this.setAwaiting(job.chatId, { ...awaiting, messageId: sent.messageId })
    }
    this.logger?.info('task parked for plan approval', { taskId: job.id, planChars: drafted.plan.length })
    return { awaitingPlan: true }
  }

  /** Inline keyboard for plan approval. */
  planKeyboard(taskId) {
    return {
      rows: [
        [{ text: '✅ Выполнять', data: `p:${taskId}:run` }],
        [{ text: '✖️ Отменить', data: `x:${taskId}:0` }],
      ],
    }
  }

  /** Run the task with the plan the owner approved. */
  async approvePlan({ awaiting, chatId, userId, replyToMessageId }) {
    await this.clearAwaiting(chatId)
    await this.enqueueJob({
      continuationOf: awaiting.taskId,
      id: awaiting.taskId,
      chatId,
      userId,
      // The original text travels with the plan: the planner is not part of the
      // task session, so the executor would otherwise not know what to do.
      text: `Задача: ${awaiting.originalText}\n\nУтверждённый план (следуй ему):\n${awaiting.plan}`,
      attachments: [],
      replyToMessageId,
      planApproved: true,
      forceDsh: true,
      brief: awaiting.brief,
    })
  }

  /** Whether this task should be offered to the quick layer at all. */
  shouldTryQuick(job) {
    if (!this.quick?.enabled) return false
    if (this.config.routing.mode !== 'auto') return false
    // A retry exists because the first answer was not enough, and a continuation
    // only makes sense with the conversation: both always go to the executor.
    if (job.forceDsh || job.continuationOf) return false
    return !needsExecutor(
      { text: job.text, attachments: job.attachments },
      { maxChars: this.config.routing.maxChars },
    )
  }

  /**
   * Try to answer without starting a task.
   *
   * @param {object} request - `job` and the id of its status message.
   * @returns {Promise<object|undefined>} a marker when answered, undefined to run DSH.
   */
  async tryQuickAnswer({ job, statusMessageId, controller: providedController, budget, startedAt, leaseContext = {} }) {
    if (!this.shouldTryQuick(job)) return undefined
    const controller = providedController ?? new AbortController()
    const quickSignal = controller.signal
    this.lifecycle.begin({
      id: job.id,
      chatId: job.chatId,
      controller,
      startedAt: startedAt ?? this.now().getTime(),
      attemptId: `${job.id}-quick`,
    })
    let outcome
    try {
      outcome = await this.orchestrator.run({
        executorId: 'quick',
        job,
        task: job.text,
        signal: quickSignal,
        budget,
        stopping: this.stopping,
        onStage: (stage) => {
          if (this.running?.id === job.id) this.lifecycle.updateRunning({ stage }, job.id)
        },
        onUsage: (usage) => {
          if ((usage?.totalTokens ?? 0) > 0) {
            this.usage.record({
              usage: toProviderUsage(usage),
              userId: job.userId,
              chatId: job.chatId,
              date: this.now(),
              timeZone: this.config.runtime.timeZone,
            })
          }
        },
      })
    } finally {
      this.lifecycle.finish(job.id)
    }
    const quick = outcome?.result?.quick
    const cancelled = [STATUS.cancelled, STATUS.interrupted].includes(outcome?.status)
    const budgetBlocked = ['budget', 'unknown_budget'].includes(outcome?.reason)
    if (leaseContext.leaseSignal?.aborted) {
      return { quick: true, cancelled: true, leaseLost: true, text: quick?.text ?? '' }
    }
    if (cancelled || budgetBlocked) {
      await this.lifecycle.finishTask(job.id, { status: outcome.status, reason: outcome.reason, quick: true })
      return { quick: true, cancelled, budgetBlocked, text: quick?.text ?? '' }
    }
    if (!quick || quick.routed !== 'quick') return { fallback: true }

    const cost = costOf(quick.usage, this.pricingOptions())
    const status = outcome.status === STATUS.cancelled || outcome.status === STATUS.interrupted
      ? outcome.status
      : outcome.status
    const quickText = String(quick.text ?? '').trim()
    const routeEvent = job.route
      ? buildResultEvent({
        task: { ...job, route: job.route },
        text: quickText,
        files: [],
        version: job.resultVersion ?? 1,
        maxChars: this.config.delivery?.textChars ?? 3500,
      })
      : undefined
    const personalOutbox = job.route
      ? undefined
      : {
        eventId: `personal:${job.id}:${job.resultVersion ?? 1}`,
        kind: 'personal',
        taskId: job.id,
        chatId: job.chatId,
        text: quickText,
        replyToMessageId: this.jobReplyTo(job),
      }
    const accepted = leaseContext.accept?.({
      status,
      payload: { summary: { text: quickText, files: [], version: job.resultVersion ?? 1 }, resultFiles: [] },
      outbox: routeEvent ? { eventId: routeEvent.eventId, event: routeEvent } : personalOutbox,
    })
    if (accepted && accepted.ok === false && accepted.unsupported !== true) {
      return { quick: true, cancelled: true, text: quickText }
    }
    await this.lifecycle.finishTask(job.id, {
      status,
      reason: outcome.reason,
      quick: true,
      durationMs: quick.durationMs,
      steps: 1,
      tokens: {
        total: quick.usage.totalTokens,
        uncachedInput: quick.usage.inputTokens,
        cachedInput: quick.usage.cacheReadTokens,
        output: quick.usage.outputTokens,
      },
      usd: cost.usd,
      peak: cost.peak,
    })
    if (status === STATUS.cancelled || status === STATUS.interrupted) {
      this.logger?.info('quick answer cancelled', { taskId: job.id, status })
      return { quick: true, cancelled: true, text: quick.text ?? '' }
    }
    if (job.route) {
      await this.lifecycle.update(job.id, { resultSummary: { text: quickText, files: [], version: job.resultVersion ?? 1 } })
      await this.delivery?.enqueue(routeEvent)
      return { quick: true, text: quickText }
    }
    await this.markStatus({ chatId: job.chatId, statusMessageId, markdown: quickStatus({ taskId: job.id }) })
    await this.safeSend(job.chatId, [
      quick.text,
      quickFooter({ tokens: quick.usage.totalTokens, usdText: formatUsd(cost.usd), taskId: job.id }),
    ].join('\n'), { replyToMessageId: this.jobReplyTo(job) })
    await this.mirrorResult(quick.text, job.id)
    return { quick: true, text: quick.text }
  }

  /** Abort the running task, drop the open question and clear the queue. */
  async cancelAll(chatId) {
    const queued = this.queue.length
    await this.clearQueue('отменено командой /cancel')
    const awaiting = this.awaitingFor(chatId)
    if (awaiting) {
      await this.clearAwaiting(chatId)
      await this.lifecycle.update(awaiting.taskId, {
        status: STATUS.cancelled,
        reason: 'cancelled',
        error: 'отменено пользователем',
      }).catch(() => {})
    }
    if (this.running?.controller) {
      this.logger?.info('cancelling running task', { taskId: this.running.id, queued })
      const cancelledRunning = this.lifecycle.cancelRunning()
      await this.safeSend(chatId, `⛔ Останавливаю задачу ${cancelledRunning?.id ?? this.running.id}${queued > 0 ? ` и убираю из очереди ${queued}` : ''}.`)
      return
    }
    if (awaiting) {
      await this.safeSend(chatId, `Вопрос по задаче ${awaiting.taskId} снят.`)
      return
    }
    await this.safeSend(chatId, queued > 0 ? `Очередь очищена (${queued}).` : 'Нечего отменять.')
  }

  /** Отменить все задачи, которые ещё стоят в очереди, не теряя их из журнала. */
  async clearQueue(reason) {
    return this.lifecycle.clearQueue(reason)
  }

  /** Закрыть задачу ошибкой, не падая на недопустимом переходе. */
  async failTask(id, { reason = 'internal', error, status = STATUS.failed } = {}) {
    try {
      await this.lifecycle.finishTask(id, { status, reason, error })
    } catch (cause) {
      this.logger?.warn('task status update failed', { taskId: id, error: cause })
    }
  }

  /**
   * Продолжить прерванную задачу.
   *
   * Если в журнале действий есть незавершённые внешние действия, сначала нужен
   * явный ответ владельца: повторять отправку молча нельзя.
   */
  async continueInterrupted({ args } = {}) {
    if (!this.journal) return 'Журнал задач недоступен.'
    const parts = String(args ?? '').trim().split(/\s+/).filter(Boolean)
    const id = parts[0]
    const confirmed = parts.includes('--yes')
    if (!id) return 'Укажите id: /continue <id>. Список — /tasks.'
    const record = this.journal.get(id)
    if (!record) return `Задача ${id} не найдена.`
    if (record.status === STATUS.queued) return `Задача ${id} уже в очереди.`
    if (record.status !== STATUS.interrupted) {
      return `Продолжить можно только прерванную задачу; ${id} сейчас — ${record.status}.`
    }
    const unresolved = this.actions?.unresolved(id) ?? []
    if (unresolved.length > 0 && !confirmed) {
      const list = unresolved.slice(0, 5).map((action) => `• ${action.kind}${action.target ? ` → ${action.target}` : ''}`)
      return [
        `У задачи ${id} есть действия с неизвестным исходом:`,
        ...list,
        '',
        'Если внешнего эффекта не было или вы уже видели результат — повторите:',
        `/continue ${id} --yes`,
      ].join('\n')
    }
    const text = String(record.request ?? record.text ?? '').trim()
    if (text === '') return `У задачи ${id} не сохранился текст запроса.`
    const prompt = record.sessionId
      ? `Продолжи прерванную задачу с того места, где остановилась. Исходная задача:\n${text}`
      : text
    await this.lifecycle.retry({
      taskId: id,
      job: this.recordToJob(this.journal.get(id)),
      reason: 'продолжение прерванной задачи',
      patch: {
        text: prompt,
        request: text.slice(0, 4000),
        sessionId: record.sessionId,
        brief: record.brief,
        resumedAt: this.now().getTime(),
      },
    })
    this.worker = this.worker.then(() => this.drain()).catch((error) => {
      this.logger?.error('continue worker failed', { error })
    })
    return `▶️ Продолжаю задачу ${id} с сохранённого места.`
  }

  // ─── личные процедуры ────────────────────────────────────────────────────

  /** Разобрать «procedure:<name> key=value …» из расписания. */
  parseProcedureTask(text) {
    const match = String(text ?? '').match(/^procedure:([^\s]+)(?:\s+([\s\S]*))?$/)
    if (!match) return undefined
    return { name: match[1], params: this.parseParams(match[2] ?? '') }
  }

  /** Параметры вида key=value. */
  parseParams(text) {
    const params = {}
    for (const part of String(text ?? '').trim().split(/\s+/).filter(Boolean)) {
      const index = part.indexOf('=')
      if (index > 0) params[part.slice(0, index)] = part.slice(index + 1)
    }
    return params
  }

  /** Сохранить/показать/запустить процедуру. */
  async procedureCommand({ args } = {}) {
    if (!this.procedures) return 'Процедуры недоступны.'
    const text = String(args ?? '').trim()
    const [sub, ...rest] = text.split(/\s+/)
    const restText = rest.join(' ')
    const list = this.procedures.list()
    const format = (record) => {
      const active = record.versions.find((version) => version.version === record.activeVersion)
      const draft = record.versions.find((version) => version.status === 'draft')
      const state = active ? `v${active.version}` : draft ? `черновик v${draft.version}` : 'нет версии'
      return `• ${record.name} — ${state}`
    }
    switch ((sub ?? '').toLowerCase()) {
      case '':
      case 'list':
        if (list.length === 0) return 'Процедур пока нет. Сохранить: /procedure save <имя> <id задачи>.'
        return ['Личные процедуры:', ...list.map(format), '', 'Подробнее: /procedure show <имя>.'].join('\n')
      case 'show': {
        const record = this.procedures.get(restText.trim())
        if (!record) return `Процедура «${restText.trim()}» не найдена.`
        const lines = [`Процедура «${record.name}» (${record.id}):`]
        for (const version of record.versions) {
          const active = version.version === record.activeVersion ? ' ← активная' : ''
          lines.push(`  v${version.version} [${version.status}]${active}: ${version.purpose || '—'}`)
        }
        const draft = record.versions.find((version) => version.status === 'draft')
        if (draft) {
          const missing = this.procedures.missingFields(draft)
          if (missing.length > 0) lines.push(`  черновику не хватает: ${missing.join(', ')}`)
        }
        return lines.join('\n')
      }
      case 'save':
      case 'edit': {
        const [name, taskId] = restText.trim().split(/\s+/)
        if (!name || !taskId) return `Формат: /procedure ${sub} <имя> <id задачи>.`
        const record = this.journal?.get(taskId)
        if (!record) return `Задача ${taskId} не найдена.`
        const criteria = this.verifier?.criteriaFor?.({ taskText: record.request ?? record.text ?? '', files: [] }) ?? []
        try {
          const result = sub === 'save'
            ? await this.procedures.saveFromTask({ name, record, criteria })
            : await this.procedures.editFromTask({ name, record, criteria })
          const version = result.version
          return version.status === 'active'
            ? `Процедура «${name}» сохранена и активна (v${version.version}). Запуск: /procedure run ${name}.`
            : `Процедура «${name}» сохранена черновиком v${version.version}; не хватает: ${result.missing.join(', ')}. Дозаполните /procedure set и активируйте.`
        } catch (error) {
          return `Не сохранил процедуру: ${String(error?.message ?? error)}`
        }
      }
      case 'set': {
        const [name, field] = restText.trim().split(/\s+/)
        const value = restText.trim().slice(String(name ?? '').length + String(field ?? '').length + 2)
        if (!name || !field || value === '') return 'Формат: /procedure set <имя> <поле> <значение>.'
        try {
          const result = await this.procedures.setField(name, field, value)
          return result.missing.length === 0
            ? `Поле «${field}» заполнено; активируйте: /procedure activate ${name}.`
            : `Поле «${field}» заполнено; ещё не хватает: ${result.missing.join(', ')}.`
        } catch (error) {
          return `Не изменил процедуру: ${String(error?.message ?? error)}`
        }
      }
      case 'activate': {
        const name = restText.trim()
        try {
          const result = await this.procedures.activate(name)
          return `Процедура «${name}» активна: v${result.version.version}. Запуск: /procedure run ${name}.`
        } catch (error) {
          return `Не активировал: ${String(error?.message ?? error)}`
        }
      }
      case 'run': {
        const [name, ...paramParts] = restText.trim().split(/\s+/)
        if (!name) return 'Формат: /procedure run <имя> [ключ=значение …].'
        const rendered = this.procedures.render({ name, params: this.parseParams(paramParts.join(' ')) })
        if (!rendered.ok) return `Не запускаю: ${rendered.error}`
        const outcome = await this.enqueueJob({
          id: this.journal ? this.journal.nextId(this.now()) : `proc-${this.now().getTime().toString(36)}`,
          chatId: this.alertChatId(),
          userId: this.alertChatId(),
          text: rendered.text,
          attachments: [],
          brief: `🧩 ${name} v${rendered.version}`,
          procedure: { id: rendered.procedure.id, name, version: rendered.version, params: this.parseParams(paramParts.join(' ')), limits: rendered.limits ?? {} },
          variantsMode: 'never',
          freshSession: true,
          forceDsh: true,
        })
        return outcome?.queued ? `🧩 Запускаю процедуру «${name}» v${rendered.version}.` : `Не запустил: ${outcome?.reason ?? 'очередь недоступна'}`
      }
      case 'remove': {
        const name = restText.trim()
        return (await this.procedures.remove(name)) ? `Процедура «${name}» удалена.` : `Процедура «${name}» не найдена.`
      }
      default:
        return ['Процедуры: /procedure list | show <имя> | save <имя> <id> | edit <имя> <id> | set <имя> <поле> <значение> | activate <имя> | run <имя> [ключ=значение] | remove <имя>.'].join('\n')
    }
  }

  // ─── память ──────────────────────────────────────────────────────────────

  /** Что из памяти попадает в задачу: отобранные факты + факты ассистента на задачу. */
  memoryForTask(job) {
    const parts = []
    const selected = this.memory?.renderForTask?.({
      text: job.text,
      scope: { type: 'chat', value: job.chatId },
      budget: this.config.memory?.contextChars ?? 1500,
    })
    if (selected) parts.push(selected)
    if (Array.isArray(job.facts) && job.facts.length > 0) {
      parts.push('Факты, переданные ассистентом для этой задачи (не сохранять):')
      for (const fact of job.facts.slice(0, 50)) {
        const text = typeof fact === 'string' ? fact : fact?.text
        if (text) parts.push(`- ${String(text).slice(0, 300)}`)
      }
    }
    return parts.join('\n')
  }

  /** /memory, /memory history, /memory set, /memory purge. */
  async memoryCommand(args = '') {
    if (!this.memory) return 'Память недоступна.'
    const text = String(args ?? '').trim()
    const [sub, ...rest] = text.split(/\s+/)
    const restText = rest.join(' ')
    if ((sub ?? '').toLowerCase() === 'history') {
      const subject = restText.trim() || undefined
      const facts = this.memory.history(subject)
      if (facts.length === 0) return 'Истории памяти пока нет.'
      return [
        subject ? `История по «${subject}»:` : 'История памяти:',
        ...facts.map((fact) => `• [${fact.status}] ${fact.text} — ${new Date(fact.createdAt).toLocaleDateString('ru-RU')}${fact.source ? ` (${fact.source})` : ''}`),
      ].join('\n')
    }
    if ((sub ?? '').toLowerCase() === 'set') {
      const [subject, ...words] = restText.trim().split(/\s+/)
      if (!subject || words.length === 0) return 'Формат: /memory set <предмет> <значение>.'
      const fact = await this.memory.set({ subject, text: words.join(' '), source: 'owner', owner: 'owner' })
      return fact
        ? `🧠 Запомнил: «${fact.text}» (предмет ${subject}); прежнее значение осталось в истории.`
        : 'Не сохранил: пустой факт, дубль или похоже на секрет.'
    }
    if ((sub ?? '').toLowerCase() === 'purge') {
      const count = await this.memory.clear()
      return `🧠 Память очищена: ${count}.`
    }
    return this.memoryText()
  }

  /** List the newest files in the workspace, with its total size. */
  async filesText() {
    const { dir } = this.config.workspace
    const after = await snapshot(dir)
    const total = await directorySize(dir)
    const entries = [...after.entries()]
      .map(([relPath, meta]) => ({ relPath, ...meta }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 15)
    if (entries.length === 0) return `Рабочая папка пуста (${formatSize(total.bytes)}).`
    const lines = entries.map((entry) => `• ${entry.relPath} — ${formatSize(entry.size)}`)
    return [
      'Последние файлы в рабочей папке:',
      ...lines,
      '',
      `Всего: ${formatSize(total.bytes)} в ${total.files} файлах.`,
    ].join('\n')
  }

  // ─── schedules ────────────────────────────────────────────────────────────

  /**
   * Fire every schedule that is due; called from the polling loop.
   *
   * A due schedule always advances its next occurrence, even when the run is
   * refused by the queue or the daily budget: a scheduler that retries the same
   * missed run forever turns one skip into a flood.
   *
   * @returns {Promise<number>} how many runs were queued.
   */
  async tickSchedules() {
    if (!this.schedules || !this.config.schedules.enabled) return 0
    const now = this.now()
    if (now.getTime() - this.lastScheduleAt < this.config.schedules.tickSec * 1000) return 0
    this.lastScheduleAt = now.getTime()

    let fired = 0
    for (const record of this.schedules.all()) {
      if (!record.enabled || !record.nextRunAt) continue
      if (record.nextRunAt > now.getTime()) continue

      // A minute of tick granularity is not a missed run; half a day is.
      const lateMs = now.getTime() - record.nextRunAt
      const lateMinutes = Math.max(0, Math.round(lateMs / 60_000))
      const reallyMissed = lateMs > this.config.schedules.tickSec * 2000
      const next = nextRunAt(parseCron(record.cron), now, { timeZone: this.schedules.timeZone })
      await this.schedules.update(record.id, {
        nextRunAt: next?.getTime(),
        lastRunAt: now.getTime(),
        runs: (record.runs ?? 0) + 1,
        lastLateMinutes: lateMinutes || undefined,
        missed: (record.missed ?? 0) + (reallyMissed ? 1 : 0),
      })
      this.logger?.info('schedule fired', { schedule: record.id, cron: record.cron, lateMinutes })
      let taskText = record.task
      let procedure
      if (record.procedureId || /^procedure:/.test(record.task)) {
        const parsed = record.procedureId
          ? { name: record.procedureId, params: record.procedureParams ?? {} }
          : this.parseProcedureTask(record.task)
        const rendered = parsed ? this.procedures?.render({ name: parsed.name, params: parsed.params ?? {} }) : undefined
        if (!rendered?.ok) {
          this.logger?.warn('schedule procedure unavailable', { schedule: record.id, error: rendered?.error })
          await this.alert(`🕒 Расписание ${record.id} не запущено: ${rendered?.error ?? 'процедура недоступна'}`)
          continue
        }
        taskText = rendered.text
        procedure = { id: rendered.procedure.id, name: parsed.name, version: rendered.version, params: parsed.params ?? {}, limits: rendered.limits ?? {} }
      }
      await this.enqueueJob({
        id: this.journal ? this.journal.nextId(now) : `sched-${record.id}-${now.getTime().toString(36)}`,
        chatId: record.chatId,
        userId: record.userId,
        text: taskText,
        attachments: [],
        brief: procedure ? `🧩 ${procedure.name} v${procedure.version}` : `🕒 ${record.task}`,
        procedure,
        scheduledFrom: record.id,
        // A recurring job runs unattended: asking "какой вариант?" every Monday
        // is noise, so scheduled runs never offer variants.
        variantsMode: 'never',
        freshSession: true,
      })
      fired += 1
    }
    return fired
  }

  /** `/schedule …`: list, add, remove, enable, disable, run now. */
  async scheduleCommand({ args, update }) {
    if (!this.config.schedules.enabled || !this.schedules) return 'Расписания выключены (SCHEDULES=false).'
    const text = String(args ?? '').trim()
    const [sub, ...rest] = text.split(/\s+/)
    const restText = rest.join(' ')

    switch ((sub ?? '').toLowerCase()) {
      case '':
      case 'list':
      case 'список':
        return this.scheduleText()
      case 'add':
      case 'добавить': {
        if (this.schedules.all().length >= this.config.schedules.max) {
          return `Больше ${this.config.schedules.max} расписаний не храню. Удалите лишнее: /schedule del <id>.`
        }
        const { cronText, task } = parseScheduleAdd(restText)
        if (cronText === '' || task === '') {
          return 'Формат: /schedule add "0 9 * * 1-5" текст задачи\nПоля cron: минуты, часы, день месяца, месяц, день недели.'
        }
        try {
          const record = await this.schedules.add({ chatId: update.chat.id, userId: update.from?.id, cron: cronText, task })
          const parsedProcedure = this.parseProcedureTask(task)
          if (parsedProcedure) {
            if (!this.procedures) return 'Процедуры недоступны.'
            const rendered = this.procedures.render({ name: parsedProcedure.name, params: parsedProcedure.params })
            if (!rendered.ok) {
              await this.schedules.remove(record.id)
              return `Расписание не создано: ${rendered.error}`
            }
            await this.schedules.update(record.id, { procedureId: parsedProcedure.name, procedureParams: parsedProcedure.params })
          }
          const when = record.nextRunAt
            ? new Date(record.nextRunAt).toLocaleString('ru-RU', { timeZone: this.schedules.timeZone })
            : 'не удалось вычислить'
          return `🕒 Расписание ${record.id} создано: ${describeCron(record.cron)} (${record.cron}).\nСледующий запуск: ${when}.\nЗадача: ${record.task}`
        } catch (error) {
          if (error instanceof CronError) return `Не понял расписание: ${error.message}`
          throw error
        }
      }
      case 'del':
      case 'delete':
      case 'удалить': {
        const id = restText.trim().split(/\s+/)[0]
        if (!id) return 'Укажите id: /schedule del <id>. Список — /schedule.'
        return (await this.schedules.remove(id)) ? `Расписание ${id} удалено.` : `Расписание ${id} не найдено.`
      }
      case 'on':
      case 'off': {
        const id = restText.trim().split(/\s+/)[0]
        const record = this.schedules.get(id)
        if (!record) return `Расписание ${id} не найдено.`
        const enabled = (sub ?? '').toLowerCase() === 'on'
        const next = enabled ? nextRunAt(parseCron(record.cron), this.now(), { timeZone: this.schedules.timeZone }) : undefined
        await this.schedules.update(record.id, { enabled, nextRunAt: next?.getTime() })
        return `Расписание ${id} ${enabled ? 'включено' : 'выключено'}.`
      }
      case 'run': {
        const id = restText.trim().split(/\s+/)[0]
        const record = this.schedules.get(id)
        if (!record) return `Расписание ${id} не найдено.`
        let taskText = record.task
        let procedure
        if (record.procedureId) {
          const rendered = this.procedures?.render({ name: record.procedureId, params: record.procedureParams ?? {} })
          if (!rendered?.ok) return `Не запускаю: ${rendered?.error ?? 'процедура недоступна'}`
          taskText = rendered.text
          procedure = { id: rendered.procedure.id, name: record.procedureId, version: rendered.version, params: record.procedureParams ?? {}, limits: rendered.limits ?? {} }
        }
        await this.enqueueJob({
          id: this.journal ? this.journal.nextId(this.now()) : `sched-${record.id}-${this.now().getTime().toString(36)}`,
          chatId: record.chatId,
          userId: record.userId,
          text: taskText,
          attachments: [],
          brief: procedure ? `🧩 ${procedure.name} v${procedure.version}` : `🕒 ${record.task}`,
          procedure,
          scheduledFrom: record.id,
          variantsMode: 'never',
        })
        return `🕒 Запускаю расписание ${record.id} сейчас.`
      }
      default:
        return `Неизвестная подкоманда «${sub}».\n\n${this.scheduleText()}`
    }
  }

  /** The schedule list with the next run of each. */
  scheduleText() {
    if (!this.config.schedules.enabled || !this.schedules) return 'Расписания выключены (SCHEDULES=false).'
    const records = this.schedules.all()
    if (records.length === 0) {
      return 'Расписаний нет. Пример:\n/schedule add "0 9 * * 1-5" собери сводку и пришли файлом'
    }
    const lines = records.map((record) => {
      const next = record.enabled && record.nextRunAt
        ? new Date(record.nextRunAt).toLocaleString('ru-RU', { timeZone: this.schedules.timeZone })
        : '—'
      const skipped = record.missed ? `, пропущено ${record.missed}` : ''
      return `• ${record.enabled ? '🕒' : '⏸'} ${record.id} — ${describeCron(record.cron)} (${record.cron})\n   ${record.title}\n   следующий: ${next}; выполнено ${record.runs ?? 0}${skipped}`
    })
    return [
      `Расписания (часовой пояс ${this.schedules.timeZone || 'системный'}):`,
      '',
      ...lines,
      '',
      'Управление: /schedule add|del|on|off|run',
    ].join('\n')
  }

  // ─── the queue ────────────────────────────────────────────────────────────

  /** Queue a task from a fresh message. */
  async enqueue({ update, text }) {
    const chatId = update.chat.id
    const fromBridge = this.isBridgeSource(update)
    await this.enqueueJob({
      id: this.journal ? this.journal.nextId(this.now()) : `${this.now().getTime().toString(36)}-${(this.queue.length + 1).toString(36)}`,
      chatId,
      userId: fromBridge ? (this.alertChatId() ?? update.from?.id) : update.from?.id,
      text,
      attachments: update.attachments ?? [],
      replyToMessageId: update.messageId,
      brief: text,
      bridgeFrom: fromBridge ? String(update.from?.id) : undefined,
      viaVoice: (update.attachments ?? []).some((item) => item.kind === 'voice' || item.kind === 'audio'),
      requestKey: fromBridge ? `tg:${chatId}:${update.messageId}` : undefined,
    })
  }

  /** Queue a prepared job, applying the queue and budget limits. */
  async enqueueJob(job) {
    if (this.queue.length >= QUEUE_LIMIT) {
      await this.safeSend(job.chatId, `Очередь заполнена (${QUEUE_LIMIT}). Дождитесь окончания или /cancel.`)
      return { queued: false, reason: 'очередь заполнена' }
    }
    if (this.config.limits.dailyTokenLimit > 0 && this.usage.limitReached(this.now(), this.config.runtime.timeZone)) {
      await this.safeSend(job.chatId, `Дневной лимит токенов исчерпан (${this.config.limits.dailyTokenLimit.toLocaleString('ru-RU')}). Новые задачи — завтра.`)
      await this.alert(`⚠️ Дневной лимит исчерпан, задача ${job.id} не запущена.`)
      return { queued: false, reason: 'дневной лимит токенов исчерпан' }
    }
    job.enqueuedAt = this.now().getTime()

    // Принятие задачи — это запись на диск ДО появления в памяти. Ошибка записи
    // означает «задача не принята»: ни выполнения, ни успешного ответа мосту.
    if (this.journal) {
      try {
        if (job.continuationOf) {
          const existing = this.journal.get(job.id)
          if (!existing) return { queued: false, reason: 'задача для продолжения не найдена' }
          // Продолжение наследует маршрут и версию исходной задачи.
          job.route = job.route ?? existing.route
          job.resultVersion = job.resultVersion ?? existing.resultVersion
          job.rootTaskId = job.rootTaskId ?? existing.rootTaskId
          job.revisionOf = job.revisionOf ?? existing.revisionOf
          job.facts = job.facts ?? existing.facts ?? []
          await this.lifecycle.retry({
            taskId: job.id,
            job,
            reason: job.planApproved ? 'план утверждён' : 'ответ владельца',
            patch: {
              text: job.text,
              request: String(job.text ?? '').slice(0, 4000),
              attachments: job.attachments ?? [],
              sessionId: job.sessionId,
              resumedAt: this.now().getTime(),
              brief: job.brief ?? existing.brief,
            },
          })
          job._queuedByLifecycle = true
        } else {
          const accepted = await this.journal.openQueued(job)
          if (accepted.conflict) {
            return { queued: false, conflict: true, reason: 'ключ запроса уже связан с другой задачей' }
          }
          if (accepted.duplicate) {
            this.logger?.info('duplicate bridge request', { taskId: accepted.record.id, requestKey: job.requestKey })
            return { queued: true, duplicate: true, taskId: accepted.record.id, state: accepted.record.status, position: 0 }
          }
          job.id = accepted.record.id
        }
      } catch (error) {
        this.logger?.error('task not saved', { error, taskId: job.id })
        await this.safeSend(job.chatId, `⚠️ Задача ${job.id} не принята: не удалось сохранить. Повторите позже.`)
        return { queued: false, storageFailed: true, reason: 'задача не сохранена' }
      }
    }

    if (job.bridgeFrom) {
      this.logger?.info('task accepted from the bridge', { taskId: job.id, from: job.bridgeFrom })
      if (this.config.bridge.notify) {
        await this.alert(`🔗 Задача ${job.id} пришла из чата-бота: ${String(job.brief ?? '').slice(0, 120)}`)
      }
    }
    if (!job._queuedByLifecycle) this.lifecycle.enqueue(job)
    if (this.running) {
      await this.safeSend(job.chatId, `📋 Принял, задача ${job.id} в очереди (позиция ${this.queue.length}).`)
    }
    // With several queue workers a new task must start another drain loop right
    // away; the SQLite lease prevents the same task from being claimed twice.
    if ((this.config.queue?.workers ?? 1) > 1) {
      this.worker = Promise.allSettled([this.worker, this.drain()]).then(() => {})
    } else {
      this.worker = this.worker.then(() => this.drain()).catch((error) => {
        this.logger?.error('worker failed', { error })
      })
    }
    return { queued: true, duplicate: false, taskId: job.id, position: this.queue.length }
  }

  /**
   * Queue a task that arrived over the bridge (the chat bot in Spain).
   *
   * The result goes to the owner's private chat: the task is the owner's, so it
   * counts against the owner's budget and lands where they read answers.
   *
   * @param {object} request - `task` text and an optional `source` label.
   * @returns {Promise<{taskId: string}>} the queued task id.
   * @throws {Error} when the queue or the budget refuses it, so the caller can say so.
   */
  async submitBridgedTask({ task, source, requestId } = {}) {
    const chatId = this.alertChatId()
    if (chatId === undefined) throw new Error('не настроен чат владельца для результата')
    const id = this.journal ? this.journal.nextId(this.now()) : `bridge-${this.now().getTime().toString(36)}`
    const outcome = await this.enqueueJob({
      id,
      chatId,
      userId: chatId,
      text: task,
      attachments: [],
      brief: `🔗 ${String(task).slice(0, 280)}`,
      bridgeFrom: source ?? 'http',
      requestKey: requestId ? `${source ?? 'http'}:${requestId}` : undefined,
      // A bridged task runs unattended: variants would wait for nobody, and its
      // own fresh session keeps the owner's context out of the bill.
      variantsMode: 'never',
      freshSession: true,
    })
    if (outcome?.conflict) {
      const error = new Error(outcome.reason ?? 'ключ запроса уже связан с другой задачей')
      error.code = 'CONFLICT'
      throw error
    }
    if (outcome?.storageFailed) {
      const error = new Error(outcome.reason ?? 'задача не сохранена')
      error.code = 'STORAGE_FAILED'
      throw error
    }
    if (!outcome?.queued) {
      const error = new Error(outcome?.reason ?? 'задача не поставлена в очередь')
      error.code = 'REFUSED'
      throw error
    }
    return { taskId: outcome.taskId ?? id, duplicate: Boolean(outcome.duplicate), state: outcome.state ?? 'queued' }
  }

  // ─── контракт v2 ──────────────────────────────────────────────────────────

  /** Постановка задачи по контракту v2 (маршрут, файлы, ревизия, факты). */
  async submitV2Task(request = {}) {
    const chatId = this.alertChatId()
    if (chatId === undefined) throw new Error('не настроен чат владельца для результата')
    const id = this.journal ? this.journal.nextId(this.now()) : `v2-${this.now().getTime().toString(36)}`
    let revision
    if (request.revisionOf) {
      const old = this.journal?.get(request.revisionOf)
      if (!old) {
        const error = new Error('задача для ревизии не найдена')
        error.code = 'NOT_FOUND'
        throw error
      }
      revision = {
        rootTaskId: old.rootTaskId ?? old.id,
        resultVersion: (Number(old.resultVersion) || 1) + 1,
        previousId: old.id,
        previousText: String(old.request ?? old.text ?? ''),
        previousFiles: old.resultFiles ?? [],
      }
    }
    const attachments = (request.attachments ?? []).map((item) => ({ ...item, kind: item.kind ?? 'document' }))
    const outcome = await this.enqueueJob({
      id,
      chatId,
      userId: chatId,
      text: request.task,
      attachments,
      brief: `🔗 ${String(request.task ?? '').slice(0, 280)}`,
      bridgeFrom: request.source ?? 'assistant',
      requestKey: `assistant:${request.requestId}`,
      route: request.route,
      facts: request.facts ?? [],
      // С маршрутом задача может задать вопрос: владельцу есть куда ответить.
      variantsMode: request.route ? 'auto' : 'never',
      freshSession: true,
      rootTaskId: revision?.rootTaskId,
      resultVersion: revision?.resultVersion ?? 1,
      revisionOf: revision?.previousId,
      revisionContext: revision ? { text: revision.previousText, files: revision.previousFiles } : undefined,
    })
    if (outcome?.conflict) {
      const error = new Error(outcome.reason ?? 'ключ запроса уже связан с другой задачей')
      error.code = 'CONFLICT'
      throw error
    }
    if (outcome?.storageFailed) {
      const error = new Error(outcome.reason ?? 'задача не сохранена')
      error.code = 'STORAGE_FAILED'
      throw error
    }
    if (!outcome?.queued) {
      const error = new Error(outcome?.reason ?? 'задача не поставлена в очередь')
      error.code = 'REFUSED'
      throw error
    }
    return { taskId: outcome.taskId ?? id, duplicate: Boolean(outcome.duplicate), state: outcome.state ?? 'queued' }
  }

  /** Состояние задачи для GET /v1/tasks/:id. */
  taskState(id) {
    const record = this.journal?.get(id)
    if (!record) return undefined
    const deliveries = this.delivery?.store?.ofTask(id) ?? []
    const last = deliveries[deliveries.length - 1]
    const delivery = last
      ? { state: last.state, target: last.channel, attempts: last.attempts ?? 0, outcome: last.outcome }
      : { state: 'none', target: record.route ? 'assistant' : 'personal', attempts: 0 }
    const question = record.status === STATUS.awaiting_owner
      ? { text: String(record.question ?? ''), variants: record.variants ?? [] }
      : null
    return {
      id: record.id,
      execution: record.status,
      delivery,
      question,
      result: record.resultSummary ?? null,
      verification: record.verification ?? null,
      version: record.resultVersion ?? 1,
      rootTaskId: record.rootTaskId ?? record.id,
      revisionOf: record.revisionOf ?? null,
      updatedAt: record.updatedAt ?? record.createdAt,
    }
  }

  /**
   * Ответ владельца на вопрос по контракту.
   *
   * Повтор с тем же requestId возвращает прежний ответ и не продолжает задачу
   * второй раз; тот же ключ с другим телом — конфликт.
   */
  async replyTask(id, { requestId, text, variant } = {}) {
    if (!this.journal) return undefined
    const record = this.journal.get(id)
    if (!record) return undefined
    const hash = bodyHash({ text, variant })
    const known = this.requests?.find('reply', requestId, hash)
    if (known?.conflict) {
      const error = new Error('тот же requestId с другим телом')
      error.code = 'CONFLICT'
      throw error
    }
    if (known?.record) return known.record.response ?? { taskId: id, state: record.status }
    if (record.status !== STATUS.awaiting_owner) {
      const error = new Error(`задача не ждёт ответа (${record.status})`)
      error.code = 'BAD_STATE'
      throw error
    }
    const stored = this.awaitingFor(record.chatId)
    const awaiting = stored && stored.taskId === id
      ? stored
      : {
        taskId: id,
        sessionId: record.sessionId,
        kind: (record.variants ?? []).length > 0 ? 'variant' : 'question',
        question: record.question,
        variants: record.variants,
        brief: record.brief,
      }
    const chosen = variant === undefined ? undefined : (record.variants ?? []).find((item) => Number(item.n) === Number(variant))
    const continuation = chosen
      ? buildContinuation({ kind: 'variant', variant: chosen.text, text })
      : buildContinuation({ kind: 'question', text })
    await this.continueTask({
      awaiting: { ...awaiting, taskId: id, sessionId: record.sessionId ?? awaiting.sessionId },
      chatId: record.chatId,
      userId: record.userId,
      replyToMessageId: undefined,
      continuation,
    })
    const response = { taskId: id, state: STATUS.queued }
    await this.requests?.remember('reply', requestId, { taskId: id, hash, response })
    return response
  }

  /** Отмена задачи по контракту; состояние отмены событием не дублируется. */
  async cancelTaskById(id, { requestId } = {}) {
    const record = this.journal?.get(id)
    if (!record) return undefined
    const hash = bodyHash({})
    const known = this.requests?.find('cancel', requestId, hash)
    if (known?.conflict) {
      const error = new Error('тот же requestId с другим телом')
      error.code = 'CONFLICT'
      throw error
    }
    if (known?.record) return known.record.response ?? { taskId: id, state: record.status }
    let state = record.status
    if (!TERMINAL.has(record.status)) {
      if (this.running?.id === id) {
        this.lifecycle.cancelRunning(id)
        state = STATUS.cancelled
      } else if (record.status === STATUS.queued) {
        this.lifecycle.cancelQueued(id)
        await this.lifecycle.finishTask(id, { status: STATUS.cancelled, reason: 'cancelled', error: 'отменено по контракту' })
        state = STATUS.cancelled
      } else {
        if (record.status === STATUS.awaiting_owner) await this.clearAwaiting(record.chatId)
        await this.lifecycle.finishTask(id, { status: STATUS.cancelled, reason: 'cancelled', error: 'отменено по контракту' })
        state = STATUS.cancelled
      }
    }
    const response = { taskId: id, state }
    await this.requests?.remember('cancel', requestId, { taskId: id, hash, response })
    return response
  }

  /** Ручной повтор неуспешной доставки: задача заново не выполняется. */
  async deliverAgain(args = '') {
    const id = String(args ?? '').trim().split(/\s+/)[0]
    if (id === '') return 'Укажите id: /deliver <id>.'
    if (!this.delivery?.store) return 'Доставка недоступна.'
    const failed = this.delivery.store.ofTask(id).filter((record) => record.state === 'failed')
    if (failed.length === 0) return `У задачи ${id} нет неуспешных доставок.`
    for (const record of failed) {
      await this.delivery.store.retry(record.eventId)
      await this.delivery.attempt(this.delivery.store.get(record.eventId))
    }
    return `🔁 Повторил доставку событий задачи ${id}: ${failed.length}.`
  }

  /** Уведомить владельца в личном чате, если доставка ассистенту не удалась. */
  async notifyDeliveryFailure(record, error) {
    const chatId = this.alertChatId()
    if (chatId === undefined || !this.delivery) return
    await this.delivery.enqueue({
      contract: 2,
      eventId: `${record.taskId}:failure:${record.eventId}`,
      taskId: record.taskId,
      type: 'delivery_failure',
      createdAt: this.now().getTime(),
      attempt: 1,
      chatId,
      text: `⚠️ Не удалось доставить результат задачи ${record.taskId}: ${String(error ?? 'неизвестная ошибка').slice(0, 200)}`,
    }, { channel: 'personal' })
  }

  /** Вложения контракта: скопировать файлы из реестра в inbox рабочей папки. */
  async materializeAttachments(job, dir) {
    const files = []
    const notes = []
    for (const item of job.attachments ?? []) {
      if (!/^f_[A-Za-z0-9]+$/.test(String(item?.fileId ?? ''))) continue
      const result = await this.files?.read(item.fileId)
      if (!result?.ok) {
        notes.push(`файл «${item.name ?? item.fileId}» недоступен (${result?.error ?? 'нет реестра'})`)
        continue
      }
      const name = String(item.name ?? result.record.name)
      const safeName = name.replace(/[\\/]/g, '_')
      const relPath = path.join('inbox', `${item.fileId}-${safeName}`)
      await fs.writeFile(path.join(dir, relPath), result.bytes)
      files.push({
        name,
        relPath,
        size: result.bytes.length,
        kind: item.kind ?? 'document',
        mime: item.mime ?? result.record.mime,
      })
    }
    return { files, notes, usage: {} }
  }

  /** Зарегистрировать файлы результата для события контракта. */
  async registerResultFiles(job, outputs = { selected: [] }) {
    if (!this.files) return []
    const registered = []
    for (const entry of outputs.selected) {
      const file = await readDeliverable(entry, { maxBytes: this.config.workspace.maxOutputFileBytes })
      if (file.error) continue
      const record = await this.files.create({
        bytes: file.bytes,
        name: entry.relPath.split(path.sep).pop(),
        mime: file.mime,
        direction: 'result',
      })
      registered.push({
        fileId: record.fileId,
        name: record.name,
        size: record.size,
        mime: record.mime,
        caption: `${entry.relPath} · ${formatSize(entry.size)}`,
      })
    }
    return registered
  }

  /** Сводка доставки для отчёта и /task. */
  deliverySummary(taskId) {
    const records = this.delivery?.store?.ofTask(taskId) ?? []
    const last = records[records.length - 1]
    return last ? `${last.state}${last.attempts ? ` (попыток ${last.attempts})` : ''}` : 'нет'
  }

  /** Run queued tasks one by one. */

  async drain() {
    return this.lifecycle.drain({
      runTask: (job, context) => this.executeTask(job, context),
      isStopping: () => this.stopping,
      workers: this.config.queue?.workers ?? 1,
      allowParallel: Boolean(this.config.workspace?.perTask),
      leaseTtlMs: this.config.queue?.leaseTtlMs ?? 60_000,
      onError: async (job, error) => {
        this.logger?.error('task execution failed', { taskId: job.id, error })
        await this.failTask(job.id, { reason: 'internal', error: String(error?.message ?? error).slice(0, 300) })
        await this.safeSend(job.chatId, `Внутренняя ошибка при выполнении задачи ${job.id}: ${String(error?.message ?? error).slice(0, 300)}`)
      },
    })
  }

  // ─── one task ─────────────────────────────────────────────────────────────

  /** One task: intake, DSH run, usage, files, answer — or a parked question. */
  async executeTask(job, leaseContext = {}) {
    const stale = () => Boolean(leaseContext.leaseSignal?.aborted || (leaseContext.owns && !leaseContext.owns()))
    if (stale()) return
    const dir = await prepareTaskWorkspace(this.config.workspace.dir, job.id, { perTask: this.config.workspace.perTask })
    const timeZone = this.config.runtime.timeZone

    // The queue may have waited: re-check the budget before spending anything.
    if (this.config.limits.dailyTokenLimit > 0 && this.usage.limitReached(this.now(), timeZone)) {
      await this.safeSend(job.chatId, 'Дневной лимит токенов исчерпан. Задача не запущена.')
      await this.failTask(job.id, { reason: 'budget', error: 'дневной лимит токенов' })
      return
    }

    const contractFiles = (job.attachments ?? []).some((item) => /^f_[A-Za-z0-9]+$/.test(String(item?.fileId ?? '')))
    const intake = contractFiles
      ? await this.materializeAttachments(job, dir)
      : await saveAttachments({
        platform: this.platform,
        attachments: job.attachments ?? [],
        dir,
        maxBytes: this.config.workspace.maxAttachmentBytes,
        vision: this.vision,
        ocr: this.ocr,
        stt: this.stt,
        sttMaxBytes: this.config.voice.stt.maxBytes,
        logger: this.logger,
        now: this.now,
      })
    // Reading images costs tokens too, and it happens before the run: count it
    // even if the task itself then fails or is cancelled.
    if ((intake.usage?.prompt_tokens ?? 0) + (intake.usage?.completion_tokens ?? 0) > 0) {
      this.usage.record({
        usage: intake.usage,
        userId: job.userId,
        chatId: job.chatId,
        date: this.now(),
        timeZone,
      })
      await this.maybeWarnLimit()
    }
    const issue = describeAttachmentIssues(intake.files, intake.notes)
    // One controller and one budget cover quick routing, DSH, verification and
    // repair; routing spend is not lost if the task falls through to DSH.
    const attemptController = new AbortController()
    const leaseLost = () => Boolean(leaseContext.leaseSignal?.aborted)
    // Потеря SQLite-аренды должна останавливать реальный runner, а не только
    // проверяться после завершения. Один сигнал на quick/план/DSH/проверку.
    if (leaseContext.leaseSignal) {
      if (leaseContext.leaseSignal.aborted) attemptController.abort()
      else leaseContext.leaseSignal.addEventListener('abort', () => attemptController.abort(), { once: true })
    }
    const attemptStartedAt = this.now().getTime()
    const attemptBudget = createBudget({
      tokenLimit: minLimit(this.config.limits.taskTokenBudget, job.procedure?.limits?.taskTokenBudget),
      maxSteps: minLimit(this.config.limits.taskMaxSteps, job.procedure?.limits?.taskMaxSteps),
      timeLimitMs: minLimit(this.config.limits.taskTimeoutMs, job.procedure?.limits?.taskTimeoutMs),
      now: () => this.now().getTime(),
    })
    // Drafted before the run, not shown to anyone: for a task from the bridge or
    // a schedule there is no one to approve a plan, and a plan is exactly what
    // keeps those runs from wandering (the expensive failure mode).
    const silentPlan = await this.maybePlanUnattended({ job, controller: attemptController, budget: attemptBudget })
    if (attemptController.signal.aborted) {
      if (leaseLost()) return
      await this.lifecycle.finishTask(job.id, { status: STATUS.cancelled, reason: 'cancelled' })
      return
    }

    const revisionNote = job.revisionContext
      ? [
        '',
        'Это доработка ранее выданного результата. Изменяй только то, о чём просит владелец.',
        `Прошлый запрос: ${String(job.revisionContext.text ?? '').slice(0, 1500)}`,
        (job.revisionContext.files ?? []).length > 0
          ? `Файлы прошлой версии: ${(job.revisionContext.files ?? []).map((file) => file.name).join(', ')}`
          : 'Файлы прошлой версии недоступны — скажи об этом в отчёте.',
      ].join('\n')
      : ''
    const task = buildTaskPrompt({
      text: `${job.text}${revisionNote}`,
      files: intake.files,
      notes: intake.notes.map((note) => `проблема: ${note}`),
      memory: this.memoryForTask(job),
      plan: silentPlan,
      maxChars: this.config.workspace.maxTaskChars,
      variantsMode: job.variantsMode ?? this.config.dialogue.proposeVariants,
    })

    // Задача уже сохранена при принятии; здесь только переход в выполнение.
    if (this.journal) {
      const existing = this.journal.get(job.id)
      const patch = {
        request: String(job.text ?? '').slice(0, REQUEST_KEEP_CHARS),
        text: String(job.text ?? ''),
        brief: job.brief ?? String(job.text ?? '').slice(0, 300),
        chatId: String(job.chatId),
        userId: job.userId === undefined ? undefined : String(job.userId),
        startedAt: this.now().getTime(),
        retryOf: job.retryOf,
        attachments: job.attachments ?? [],
        requestKey: job.requestKey,
      }
      try {
        if (!existing) {
          await this.journal.open({ id: job.id, chatId: job.chatId, userId: job.userId, brief: job.brief, retryOf: job.retryOf, scheduledFrom: job.scheduledFrom })
        }
        await this.lifecycle.beginTask(job.id, {
          reason: job.continuationOf ? 'ответ владельца' : 'запуск',
          patch,
        })
      } catch (error) {
        this.logger?.error('task start transition failed', { error, taskId: job.id })
      }
    }

    // Размер прошлой беседы: если он вырос выше предела, продолжаем с чистой
    // сессии. Контекст — главная статья расхода, и держать его под контролем
    // надёжнее здесь, чем надеяться на компакцию внутри DSH.
    const sessionSize = Number(this.state.get(`sessionSize:${job.chatId}`)) || 0
    const sessionLimit = this.config.runtime.sessionMaxTokens
    const sessionTooBig = sessionLimit > 0 && sessionSize > sessionLimit

    // brief: никаких промежуточных сообщений — ни «приступаю», ни прогресса.
    // markStatus и publishProgress молчат без messageId, поэтому достаточно не
    // отправлять стартовое сообщение; всё важное (проблемы вложений, пути на
    // Диске, стоимость) уходит одним итогом в конце.
    const remote = Boolean(job.route)
    const brief = this.config.report.style === 'brief' || remote
    job.issue = issue

    const status = brief ? undefined : await this.safeSend(job.chatId, [
      job.scheduledFrom
        ? `🕒 Задача ${job.id} по расписанию ${job.scheduledFrom}: приступаю.`
        : job.continuationOf ? `▶️ Продолжаю задачу ${job.id} с вашим ответом.` : `▶️ Задача ${job.id}: приступаю.`,
      sessionTooBig ? `_Беседа стала большой (${sessionSize.toLocaleString('ru-RU')} токенов контекста) — начал её с чистого листа, чтобы не платить за всю историю._` : '',
      issue === '' ? '' : `\n${issue}`,
    ].filter(Boolean).join('\n'), { replyToMessageId: this.jobReplyTo(job) })
    const statusMessageId = status?.messageId

    const quick = await this.tryQuickAnswer({
      job,
      statusMessageId,
      controller: attemptController,
      budget: attemptBudget,
      startedAt: attemptStartedAt,
      leaseContext,
    })
    if (quick && !quick.fallback) return quick

    // Big work gets a plan first: cheaper than a run that went the wrong way.
    const planned = remote ? undefined : await this.parkForPlan({ job, statusMessageId, controller: attemptController, budget: attemptBudget })
    if (planned) return planned

    // Существенная неоднозначность формата: один вопрос до выполнения.
    if (this.verifier?.ambiguous?.({ taskText: job.text })) {
      const question = this.verifier.clarify?.() ?? 'Уточните формат результата.'
      await this.lifecycle.awaitAnswer({
        taskId: job.id,
        chatId: job.chatId,
        patch: { reason: 'question', question, askedAt: this.now().getTime() },
        awaiting: {
          sessionId: undefined,
          kind: 'question',
          question,
          brief: job.brief ?? String(job.text ?? '').slice(0, 200),
        },
      })
      if (job.route) {
        await this.delivery?.enqueue(buildQuestionEvent({
          task: { ...job, route: job.route },
          text: `❓ Вопрос по задаче ${job.id}:\n${question}`,
          question,
          variants: [],
          version: job.resultVersion ?? 1,
          maxChars: this.config.delivery?.textChars ?? 3500,
        }))
      } else {
        await this.safeSend(job.chatId, `❓ Вопрос по задаче ${job.id}:\n${question}\n\n_Ответьте сообщением или /cancel._`, { replyToMessageId: this.jobReplyTo(job) })
      }
      this.logger?.info('task asks for clarification', { taskId: job.id })
      return
    }

    const before = await snapshot(dir)
    // Один контроллер попытки: быстрый слой и DSH используют его же.
    const controller = attemptController
    // One parent signal for execution, verification and repair: cancel/stop aborts
    // exactly this controller; the orchestrator links every stage to it.
    const startedAt = attemptStartedAt
    const sessionId = job.freshSession || sessionTooBig
      ? undefined
      : job.sessionId
        ?? (this.config.runtime.sessionContinuity ? this.state.get(`session:${job.chatId}`) : undefined)
    this.lifecycle.begin({
      id: job.id,
      chatId: job.chatId,
      controller,
      startedAt,
      attemptId: `${job.id}-1`,
    })
    this.progress = { steps: 0, tool: '', sessionId }
    const progressTimer = setInterval(() => {
      void this.publishProgress(statusMessageId, job)
    }, this.config.runtime.progressIntervalMs)
    progressTimer.unref?.()

    const spent = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      steps: 0,
      turns: 0,
      maxStepInputTokens: 0,
    }
    const addUsage = (usage = {}) => {
      for (const field of Object.keys(spent)) {
        if (field === 'maxStepInputTokens') spent[field] = Math.max(spent[field], Number(usage[field]) || 0)
        else spent[field] += Number(usage[field]) || 0
      }
    }
    let outputs = { selected: [] }
    let collected = false
    let usageUnknown = false
    // Расход быстрого маршрута, если задача ушла в DSH, входит в тот же итог.
    if (quick?.fallback) {
      if (quick.usage) addUsage(quick.usage)
      else if (Number(attemptBudget.state.tokens) > 0 && spent.totalTokens === 0) spent.totalTokens = Number(attemptBudget.state.tokens)
    }
    let result
    let verification
    let statusKind
    let reason
    try {
      const outcome = await this.orchestrator.run({
        job,
        task,
        sessionId,
        signal: controller.signal,
        workspaceDir: dir,
        budget: attemptBudget,
        stopping: this.stopping,
        onStage: (stage) => {
          if (this.running?.id === job.id) this.lifecycle.updateRunning({ stage }, job.id)
        },
        onUsage: (usage, info) => {
          if (info?.unknown || usage?.totalTokens === undefined) usageUnknown = true
          addUsage(usage)
          if ((usage?.totalTokens ?? 0) > 0 || (usage?.steps ?? 0) > 0) {
            this.usage.record({
              usage: toProviderUsage(usage),
              userId: job.userId,
              chatId: job.chatId,
              date: this.now(),
              timeZone,
            })
          }
          if (this.running?.id === job.id) {
            this.lifecycle.updateRunning({ steps: spent.steps, stage: info?.stage ?? this.running.stage }, job.id)
          }
        },
        verify: async ({ result: runResult, signal, budget }) => {
          const afterRun = await snapshot(dir)
          outputs = await collectOutputs({
            before,
            after: afterRun,
            dir,
            maxFiles: this.config.workspace.maxOutputFiles,
            maxBytes: this.config.workspace.maxOutputFileBytes,
          })
          collected = true
          if (!this.verifier) return undefined
          if (!this.verifier.enabled) return this.verifier.disabled()
          if (!this.verifier.applicable({ taskText: job.text, files: outputs.selected })) return this.verifier.notRequired()
          try {
            await this.lifecycle.beginVerification(job.id, { reason: 'проверка результата' })
          } catch (error) {
            this.logger?.warn('verify transition failed', { taskId: job.id, error })
          }
          let value
          try {
            value = await this.verifier.evaluate({
              taskText: job.text,
              files: outputs.selected,
              answer: runResult.text,
              root: dir,
              signal,
              budget,
            })
          } catch (error) {
            value = { status: 'unavailable', criteria: [], limitations: [String(error?.message ?? error)], checkedAt: this.now().getTime() }
          }
          if (signal?.aborted) {
            return {
              ...(value ?? {}),
              status: 'unavailable',
              criteria: value?.criteria ?? [],
              limitations: [...(value?.limitations ?? []), 'проверка прервана отменой'],
              checkedAt: this.now().getTime(),
            }
          }
          return value
        },
        repairTask: ({ feedback }) => `${job.text}\n\nПроверка результата нашла проблемы:\n${feedback}\nИсправь только их и отдай результат заново.`,
      })
      result = outcome.result
      verification = outcome.verification
      statusKind = outcome.status
      reason = outcome.reason
      // Остановка сервиса — не отмена владельцем: после рестарта задача
      // должна читаться как interrupted, а не cancelled.
      if (this.stopping && result?.aborted) {
        statusKind = STATUS.interrupted
        reason = 'перезапуск сервиса'
      }
    } catch (error) {
      this.logger?.error('orchestrator failed', { taskId: job.id, error })
      result = { ok: false, text: '', usage: {}, aborted: controller.signal.aborted, error: String(error?.message ?? error) }
      statusKind = controller.signal.aborted ? STATUS.cancelled : STATUS.failed
      reason = controller.signal.aborted ? 'cancelled' : 'internal'
    } finally {
      clearInterval(progressTimer)
      this.lifecycle.finish(job.id)
    }

    if (stale()) {
      this.logger?.warn('stale attempt dropped before terminal/report', { taskId: job.id })
      return
    }
    // A run without a verification port still needs its output files collected.
    if (!collected) {
      const afterRun = await snapshot(dir)
      outputs = await collectOutputs({
        before,
        after: afterRun,
        dir,
        maxFiles: this.config.workspace.maxOutputFiles,
        maxBytes: this.config.workspace.maxOutputFileBytes,
      })
    }

    this.logger?.info('task finished', {
      taskId: job.id,
      ok: result.ok,
      durationMs: this.now().getTime() - startedAt,
      steps: spent.steps,
      totalTokens: spent.totalTokens,
      timedOut: result.timedOut,
      aborted: result.aborted,
      status: statusKind,
    })
    if (result.sessionId && this.config.runtime.sessionContinuity && !job.freshSession) {
      this.state.set(`session:${job.chatId}`, result.sessionId)
      this.state.set(`sessionSize:${job.chatId}`, result.maxStepInputTokens ?? 0)
    }
    if (sessionTooBig) {
      this.logger?.info('session context refreshed', { chatId: job.chatId, was: sessionSize, limit: sessionLimit })
    }

    // Facts the agent chose to remember: read them, then remove the file so it
    // neither lingers nor travels to the owner as a deliverable.
    await this.ingestMemory({ job, dir })

    const cost = costOf(spent, this.pricingOptions())
    await this.lifecycle.update(job.id, {
      verification,
      durationMs: this.now().getTime() - startedAt,
      steps: spent.steps,
      tokens: {
        total: spent.totalTokens,
        uncachedInput: spent.inputTokens + spent.cacheWriteTokens,
        cachedInput: spent.cacheReadTokens,
        output: spent.outputTokens,
      },
      usd: cost.usd,
      peak: cost.peak,
      usageUnknown,
      files: outputs.selected.map((entry) => entry.relPath),
      sessionId: result.sessionId,
    })

    // A failed or aborted run is closed here; a question or a set of variants
    // parks the task instead and waits for the user.
    const reply = result.ok && !result.aborted && !result.timedOut
      ? parseReply(result.text, { maxVariants: this.config.dialogue.maxVariants })
      : { kind: 'answer', answer: result.text ?? '', question: '', variants: [] }

    if (reply.kind === 'question') {
      await this.parkForAnswer({ job, result, reply, statusMessageId, outputs })
      return
    }
    if (reply.kind === 'variants') {
      await this.parkForVariants({ job, result, reply, statusMessageId, outputs })
      return
    }

    if (stale()) {
      this.logger?.warn('stale attempt dropped before close', { taskId: job.id })
      return
    }
    const stoppedByShutdown = statusKind === STATUS.interrupted
    await this.lifecycle.finishTask(job.id, {
      status: statusKind,
      verification,
      reason,
      error: result.ok || result.aborted ? undefined : (result.stderr?.slice(-300) || result.error || `код ${result.exitCode}`),
    })
    if (stoppedByShutdown) {
      this.logger?.info('task interrupted by shutdown', { taskId: job.id })
      return
    }

    const diskPaths = await this.uploadToDisk({ job, outputs, silent: brief })
    const resultFiles = job.route ? await this.registerResultFiles(job, outputs) : []
    await this.reportResult({ job, result, status: statusKind, statusMessageId, diskPaths, resultFiles, verification, leaseContext })
    if (!job.route) {
      await this.sendOutputs({ job, outputs })
      await this.sendVoiceAnswer({ job, result })
    }
    await this.maybeWarnLimit()
    await this.maybeWarnWorkspace()
    if (statusKind === STATUS.failed && !job.route && String(job.chatId) !== String(this.alertChatId())) {
      await this.alert(`⚠️ Задача ${job.id} завершилась неудачно (${statusKind}).`)
    }
  }

  /** Park a task that asked a question, and send the question. */
  async parkForAnswer({ job, result, reply, statusMessageId, outputs }) {
    const sessionId = result.sessionId ?? job.sessionId
    await this.lifecycle.awaitAnswer({
      taskId: job.id,
      chatId: job.chatId,
      patch: {
        reason: 'question',
        question: reply.question,
        askedAt: this.now().getTime(),
        files: outputs.selected.map((entry) => entry.relPath),
      },
      awaiting: {
        sessionId,
        kind: 'question',
        question: reply.question,
        brief: job.brief ?? String(job.text ?? '').slice(0, 200),
      },
    })
    if (job.route) {
      const questionText = [
        reply.answer === '' ? '' : reply.answer,
        `❓ Вопрос по задаче ${job.id}:`,
        reply.question,
        '',
        `_Ответьте через контракт: POST /v1/tasks/${job.id}/reply._`,
      ].filter((part) => part !== '').join('\n')
      await this.delivery?.enqueue(buildQuestionEvent({
        task: { ...job, route: job.route },
        text: questionText,
        question: reply.question,
        variants: [],
        version: job.resultVersion ?? 1,
        maxChars: this.config.delivery?.textChars ?? 3500,
      }))
      this.logger?.info('remote question queued', { taskId: job.id })
      return
    }
    await this.markStatus({ chatId: job.chatId, statusMessageId, markdown: `❓ Задача ${job.id}: жду ответа.` })
    // Files are sent before the question, so the question stays the last message.
    await this.sendOutputs({ job, outputs })
    const hours = Math.max(1, Math.round(this.config.dialogue.awaitReplyMs / 3600000))
    const questionText = [
      reply.answer === '' ? '' : reply.answer,
      `❓ Вопрос по задаче ${job.id}:`,
      reply.question,
      '',
      `_Ответьте сообщением. Отменить — /cancel. Ответ жду до ${hours} ч._`,
    ].filter((part) => part !== '').join('\n')
    await this.safeSend(job.chatId, questionText, { replyToMessageId: this.jobReplyTo(job) })
    await this.mirrorResult(questionText, job.id)
    this.logger?.info('task awaits an answer', { taskId: job.id, questionChars: reply.question.length })
  }

  /** Park a task that offered variants, and send them as buttons. */
  async parkForVariants({ job, result, reply, statusMessageId, outputs }) {
    const sessionId = result.sessionId ?? job.sessionId
    await this.lifecycle.awaitAnswer({
      taskId: job.id,
      chatId: job.chatId,
      patch: {
        reason: 'variants',
        variants: reply.variants,
        question: reply.question || undefined,
        askedAt: this.now().getTime(),
        files: outputs.selected.map((entry) => entry.relPath),
      },
      awaiting: {
        sessionId,
        kind: 'variant',
        variants: reply.variants,
        question: reply.question || undefined,
        brief: job.brief ?? String(job.text ?? '').slice(0, 200),
      },
    })
    if (job.route) {
      const body = [
        reply.answer === '' ? '' : reply.answer,
        reply.question === '' ? '' : `❓ ${reply.question}`,
        `🔀 По задаче ${job.id} есть варианты:`,
        '',
        ...reply.variants.map((variant) => `${variant.n}. ${variant.text}`),
        '',
        `_Ответьте через контракт: POST /v1/tasks/${job.id}/reply._`,
      ].filter((part) => part !== '').join('\n')
      await this.delivery?.enqueue(buildQuestionEvent({
        task: { ...job, route: job.route },
        text: body,
        question: reply.question || '',
        variants: reply.variants,
        version: job.resultVersion ?? 1,
        maxChars: this.config.delivery?.textChars ?? 3500,
      }))
      this.logger?.info('remote variants queued', { taskId: job.id, variants: reply.variants.length })
      return
    }
    await this.markStatus({ chatId: job.chatId, statusMessageId, markdown: `🔀 Задача ${job.id}: предложены варианты.` })
    await this.sendOutputs({ job, outputs })
    const body = [
      reply.answer === '' ? '' : reply.answer,
      reply.question === '' ? '' : `❓ ${reply.question}`,
      `🔀 По задаче ${job.id} есть варианты:`,
      '',
      ...reply.variants.map((variant) => `*${variant.n}.* ${variant.text}`),
      '',
      '_Нажмите кнопку, ответьте номером или напишите словами — выполню выбранное._',
    ].filter((part) => part !== '').join('\n')
    const sent = await this.safeSend(job.chatId, body, {
      keyboard: this.variantsKeyboard(job.id, reply.variants),
      replyToMessageId: this.jobReplyTo(job),
    })
    await this.mirrorResult(body, job.id)
    if (sent?.messageId !== undefined) {
      const awaiting = this.awaitingFor(job.chatId)
      if (awaiting) await this.setAwaiting(job.chatId, { ...awaiting, messageId: sent.messageId })
    }
    this.logger?.info('task offered variants', { taskId: job.id, variants: reply.variants.length })
  }

  /** Inline keyboard for variant selection. */
  variantsKeyboard(taskId, variants) {
    const rows = variants.map((variant) => [{ text: variantButtonLabel(variant), data: `v:${taskId}:${variant.n}` }])
    rows.push([{ text: '✖️ Отменить', data: `x:${taskId}:0` }])
    return { rows }
  }

  /** Replace the "working" message with a new short label. */
  async markStatus({ chatId, statusMessageId, markdown }) {
    if (!statusMessageId) return
    try {
      await this.platform.editText({ chatId, messageId: statusMessageId, markdown })
    } catch (error) {
      this.logger?.debug('status edit failed', { error })
    }
  }

  /** Edit the status message with elapsed time and activity. */
  async publishProgress(statusMessageId, job) {
    if (!statusMessageId || !this.running || this.running.id !== job.id) return
    const elapsedMin = Math.floor((this.now().getTime() - this.running.startedAt) / 60000)
    const activity = this.progress?.tool ? `, последнее действие: ${this.progress.tool}` : ''
    try {
      await this.platform.editText({
        chatId: job.chatId,
        messageId: statusMessageId,
        markdown: `⏳ Задача ${job.id}: работаю ${elapsedMin} мин, шагов ${this.running.steps}${activity}.`,
      })
    } catch (error) {
      this.logger?.debug('progress edit failed', { error })
    }
  }

  /** Answer text for the finished task. */
  async reportResult({ job, result, status, statusMessageId, diskPaths = [], resultFiles = [], verification, leaseContext = {} }) {
    // Текст ответа собирает домен delivery: ядро передаёт только данные и числа.
    const cost = costOf(result.usage, this.pricingOptions())
    const usdText = formatUsd(cost.usd)
    const text = composeReportText({
      result,
      job,
      verification,
      limits: this.config.limits,
      reportStyle: this.config.report.style,
      maxAnswerChars: this.config.workspace.maxAnswerChars,
      errorTailChars: ERROR_TAIL_CHARS,
      diskPaths,
      usdText,
      footer: result.aborted || result.timedOut
        ? undefined
        : {
            minutes: Math.max(1, Math.round(result.durationMs / 60000)),
            steps: result.usage.steps,
            tokens: result.usage.totalTokens,
            usdText,
          },
    })

    if (job.route) {
      const summary = { text: String(result.text ?? '').trim(), files: resultFiles, version: job.resultVersion ?? 1 }
      await this.lifecycle.update(job.id, { resultSummary: summary, resultFiles })
      if (result.aborted || result.timedOut) return
      const event = buildResultEvent({
        task: { ...job, route: job.route },
        text,
        files: resultFiles,
        version: job.resultVersion ?? 1,
        maxChars: this.config.delivery?.textChars ?? 3500,
      })
      // Граница принятия: терминальный статус и outbox фиксируются атомарно в
      // источнике истины до отправки. После этого доставка только читает outbox.
      const accepted = leaseContext.accept?.({ status: status ?? 'done', payload: { summary, resultFiles }, outbox: { eventId: event.eventId, event } })
      if (accepted && accepted.ok === false && accepted.unsupported !== true) {
        this.logger?.warn('result not accepted by stale attempt', { taskId: job.id, stale: accepted.stale })
        return
      }
      await this.delivery?.enqueue(event)
      return
    }
    const safeText = redactSecrets(text)
    if (safeText !== text) this.logger?.warn('secret redacted from report', { taskId: job.id })
    // Личный путь тоже фиксирует принятие до отправки; outbox для него пока не
    // создаётся отдельно — доставка идёт напрямую, ограничение зафиксировано.
    const personalOutbox = {
      eventId: `personal:${job.id}:${job.resultVersion ?? 1}`,
      kind: 'personal',
      taskId: job.id,
      chatId: job.chatId,
      text: safeText,
      replyToMessageId: this.jobReplyTo(job),
    }
    const personalAccepted = leaseContext.accept?.({
      status: status ?? 'done',
      payload: { summary: { text: safeText, files: [] }, resultFiles: [] },
      outbox: personalOutbox,
    })
    if (personalAccepted && personalAccepted.ok === false && personalAccepted.unsupported !== true) return
    await this.markStatus({
      chatId: job.chatId,
      statusMessageId,
      markdown: statusMarkdown({ result, taskId: job.id, limits: this.config.limits }),
    })
    const sent = await this.safeSend(job.chatId, safeText, {
      replyToMessageId: this.jobReplyTo(job),
    })
    await this.delivery?.trackPersonal?.({ taskId: job.id, text, chatId: job.chatId, receipt: sent?.messageId })
    await this.mirrorResult(text, job.id)
  }

  /**
   * Read the answer aloud when that is what the person expects.
   *
   * `VOICE_REPLY=auto` (the default) answers with a voice note only when the task
   * arrived as one: replying to text with audio is noise, but a person walking
   * with a phone gets exactly what they sent.
   */
  async sendVoiceAnswer({ job, result }) {
    if (!this.tts) return
    const mode = this.config.voice.reply
    if (mode === 'never') return
    if (mode === 'auto' && !job.viaVoice) return
    if (result.aborted || !result.ok) return
    const text = String(result.text ?? '').trim()
    if (text === '') return
    try {
      const bytes = await this.tts(text)
      await this.platform.sendVoice({
        chatId: job.chatId,
        bytes,
        caption: undefined,
        replyToMessageId: job.replyToMessageId,
      })
      this.logger?.info('voice answer sent', { taskId: job.id, bytes: bytes.length })
    } catch (error) {
      // A failed synthesis must never turn a finished task into a failed one.
      this.logger?.warn('voice answer failed', { taskId: job.id, error })
    }
  }

  /** Send every collected deliverable. */
  async sendOutputs({ job, outputs }) {
    const { selected, skipped } = outputs
    for (const [index, entry] of selected.entries()) {
      const file = await readDeliverable(entry, { maxBytes: this.config.workspace.maxOutputFileBytes })
      if (file.error) {
        await this.safeSend(job.chatId, `⚠️ Не отправил «${entry.relPath}»: ${file.error}`)
        continue
      }
      const caption = `${entry.relPath} · ${formatSize(entry.size)}`
      const replyToMessageId = index === 0 ? job.replyToMessageId : undefined
      const action = await this.beginAction(job.id, 'file', entry.relPath)
      try {
        let sent
        if (file.photo && file.bytes.length <= PHOTO_SEND_LIMIT) {
          sent = await this.platform.sendPhoto({ chatId: job.chatId, bytes: file.bytes, fileName: entry.relPath.split(path.sep).pop(), caption, replyToMessageId })
        } else {
          sent = await this.platform.sendDocument({
            chatId: job.chatId,
            bytes: file.bytes,
            fileName: entry.relPath.split(path.sep).pop(),
            caption,
            mime: file.mime,
            replyToMessageId,
          })
        }
        await this.confirmAction(action, sent?.messageId)
        this.logger?.info('deliverable sent', { taskId: job.id, file: entry.relPath, bytes: entry.size })
      } catch (error) {
        await this.unknownAction(action, 'file send failed')
        this.logger?.warn('deliverable send failed', { file: entry.relPath, error })
        await this.safeSend(job.chatId, `⚠️ Не удалось отправить «${entry.relPath}»: ${String(error?.description ?? error?.message ?? error).slice(0, 200)}`)
      }
    }
    if (skipped.length > 0) {
      await this.safeSend(job.chatId, `В рабочей папке остались файлы сверх лимита (${skipped.length}): ${skipped.slice(0, 10).join(', ')}.`)
    }
  }

  // ─── alerts and helpers ───────────────────────────────────────────────────

  /** Warn once a day when the budget crosses the configured threshold. */
  async maybeWarnLimit() {
    const limit = this.config.limits.dailyTokenLimit
    if (!limit) return
    const timeZone = this.config.runtime.timeZone
    const spent = this.usage.tokens(this.now(), timeZone)
    const percent = (spent / limit) * 100
    if (percent < this.config.alerts.limitPercent) return
    const today = dayKey(this.now(), timeZone)
    if (this.state.get('limitWarnedDay') === today) return
    this.state.set('limitWarnedDay', today)
    await this.alert(`⚠️ Израсходовано ${spent.toLocaleString('ru-RU')} из ${limit.toLocaleString('ru-RU')} токенов за сегодня (${Math.round(percent)}%).`)
  }

  /** Warn once a day when the workspace outgrows the configured size. */
  async maybeWarnWorkspace() {
    const limitMb = this.config.workspace.alertMb
    if (!limitMb) return
    const { bytes, files } = await directorySize(this.config.workspace.dir)
    if (bytes < limitMb * 1024 * 1024) return
    const today = dayKey(this.now(), this.config.runtime.timeZone)
    if (this.state.get('workspaceWarnedDay') === today) return
    this.state.set('workspaceWarnedDay', today)
    await this.alert(`💾 Рабочая папка выросла до ${formatSize(bytes)} (${files} файлов). Временные файлы задач чистятся сами по OUTPUT_RETENTION_DAYS, черновики в корне папки — нет.`)
  }

  /** Send a short system message to the owner. */
  async alert(text) {
    const chatId = this.alertChatId()
    if (chatId === undefined) return
    await this.safeSend(chatId, text)
  }

  /**
   * The message a bridged task must answer.
   *
   * Telegram hides a bot's messages in a group from other bots unless they are
   * replies or mentions, so the answer to the chat bot has to be sent as a reply
   * to its own message — otherwise the return leg of the bridge is silent.
   */
  jobReplyTo(job) {
    return job?.bridgeFrom ? job.replyToMessageId : undefined
  }

  /** Send text, reporting (not throwing) a Telegram failure. */
  async safeSend(chatId, markdown, { keyboard, replyToMessageId } = {}) {
    if (!markdown) return undefined
    try {
      const sent = await this.platform.sendText({ chatId, markdown, keyboard, replyToMessageId })
      return sent
    } catch (error) {
      this.logger?.error('sendMessage failed', { chatId, error })
      return undefined
    }
  }

  /**
   * Дублировать в чат-бота ТОЛЬКО результат работы или запрос информации.
   *
   * Служебные сообщения (статусы, прогресс, отметки, сводки, алерты) зеркалировать нельзя:
   * владелец получал поток вместо результата. Ошибка зеркалирования на доставку не влияет.
   */
  async mirrorResult(markdown, taskId) {
    const text = String(markdown ?? '').trim()
    if (text === '') return
    const action = await this.beginAction(taskId, 'mirror', 'outbox')
    try {
      const result = await this.mirror(text, this.config, { logger: this.logger })
      await this.confirmAction(action, result?.status ?? result?.messageId)
    } catch (error) {
      await this.unknownAction(action, 'mirror failed')
      this.logger?.debug?.('mirror failed', { error })
    }
  }

  /** Начать внешнее действие в журнале (если журнал включён). */
  async beginAction(taskId, kind, target) {
    if (!this.actions || !taskId) return undefined
    try {
      return await this.actions.begin({ taskId, kind, target })
    } catch (error) {
      this.logger?.warn('action log begin failed', { error, kind })
      return undefined
    }
  }

  /** Подтвердить внешнее действие. */
  async confirmAction(action, receipt) {
    if (!action) return
    try {
      await this.actions.confirm(action.id, { receipt })
    } catch (error) {
      this.logger?.warn('action log confirm failed', { error })
    }
  }

  /** Отметить внешнее действие как неизвестное. */
  async unknownAction(action, reason) {
    if (!action) return
    try {
      await this.actions.unknown(action.id, { reason })
    } catch (error) {
      this.logger?.warn('action log unknown failed', { error })
    }
  }

  /** Count DSH events for the progress message; wired to the runner. */
  onDshEvent(event) {
    if (!this.running) return
    if (event?.type === 'tool_call') {
      const running = this.lifecycle.snapshot().running
      this.lifecycle.updateRunning({ steps: (running?.steps ?? 0) + 1, tools: (running?.tools ?? 0) + 1 }, running?.id)
      if (this.progress) this.progress.tool = String(event.tool ?? '')
    } else if (event?.type === 'status' && event.phase === 'step_end') {
      if (this.progress) this.progress.tool = ''
    }
    // Отметка прогресса — не чаще раза в 15 секунд: после сбоя видно, где остановились.
    const at = this.now().getTime()
    if (this.journal && this.running && at - (this.lastProgressAt ?? 0) > 15_000) {
      this.lastProgressAt = at
      void this.journal.progress(this.running.id, { steps: this.running.steps, tool: this.progress?.tool }).catch(() => {})
    }
  }
}

/**
 * Pick the variant a user named in words: `2`, `вариант 2`, `2)`.
 *
 * @param {string} text - the message.
 * @param {Array<{n: number, text: string}>} variants - the offered variants.
 * @returns {object|undefined} the chosen variant.
 */
export function matchVariant(text, variants = []) {
  const match = String(text ?? '').trim().match(/^(?:вариант\s*)?(\d{1,2})\s*[.)]?$/i)
  if (!match) return undefined
  const n = Number(match[1])
  return variants.find((variant) => variant.n === n)
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Отправить текст ответа в точку приёма чат-бота (настройки — из домена config). */
