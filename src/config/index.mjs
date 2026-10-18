/**
 * Configuration for the task agent, read from the environment.
 *
 * Every field has a default except the secrets, and validation fails fast with
 * an actionable message instead of starting a half-configured agent.
 *
 * Error messages never echo a value: a secret in the wrong variable would
 * otherwise be printed verbatim by the entry point, bypassing the logger's
 * redaction. They report the length instead.
 */

/** Defaults applied when the variable is absent or empty. */

import { DEFAULTS, read } from './env.mjs'
import {
  ConfigError,
  absolutePath,
  boolean,
  choice,
  clockMinutes,
  nonNegativeNumber,
  numberInRange,
  parseUserIds,
  positiveInt,
  variantsMode,
} from './values.mjs'

// Публичная поверхность домена: настройки, ошибка и имена секретов для редактирования логов.
export { ConfigError, parseUserIds }

export function loadConfig(env = process.env) {
  const token = String(env.TELEGRAM_BOT_TOKEN ?? '').trim()
  if (token === '') throw new ConfigError('TELEGRAM_BOT_TOKEN: не задан токен бота агента')
  if (!token.includes(':')) throw new ConfigError('TELEGRAM_BOT_TOKEN: токен должен содержать «:» (формат <id>:<secret>)')

  const allowAll = boolean(read(env, 'ALLOW_ALL_USERS'), 'ALLOW_ALL_USERS')
  const allowedUserIds = parseUserIds(env.ALLOWED_USER_IDS)
  if (!allowAll && allowedUserIds.size === 0) {
    throw new ConfigError('ALLOWED_USER_IDS: список пуст, а ALLOW_ALL_USERS=false — бот не ответит никому')
  }

  const maxTaskChars = positiveInt(read(env, 'MAX_TASK_CHARS'), 'MAX_TASK_CHARS', { min: 100, max: 200_000 })
  const maxAttachmentBytes = positiveInt(read(env, 'MAX_ATTACHMENT_BYTES'), 'MAX_ATTACHMENT_BYTES', { min: 1024, max: 2_000_000_000 })

  return {
    telegram: {
      token,
      apiBase: String(read(env, 'TELEGRAM_API_BASE')).replace(/\/+$/, ''),
      timeoutMs: positiveInt(read(env, 'TELEGRAM_TIMEOUT_MS'), 'TELEGRAM_TIMEOUT_MS', { min: 5000, max: 600_000 }),
      pollTimeoutSec: positiveInt(read(env, 'POLL_TIMEOUT_SEC'), 'POLL_TIMEOUT_SEC', { min: 1, max: 300 }),
      allowedUserIds,
      allowAllUsers: allowAll,
      denyMessage: String(read(env, 'DENY_MESSAGE')),
    },
    dsh: {
      bin: absolutePath(read(env, 'DSH_BIN'), 'DSH_BIN'),
      profile: String(read(env, 'DSH_PROFILE')).trim() || 'headless',
      home: absolutePath(read(env, 'DSH_HOME'), 'DSH_HOME'),
      permissionMode: String(read(env, 'DSH_PERMISSION_MODE')).trim() || 'workspace-write',
    },
    workspace: {
      dir: absolutePath(read(env, 'WORKSPACE_DIR'), 'WORKSPACE_DIR'),
      stateDir: absolutePath(read(env, 'STATE_DIR'), 'STATE_DIR'),
      maxTaskChars,
      maxAnswerChars: positiveInt(read(env, 'MAX_ANSWER_CHARS'), 'MAX_ANSWER_CHARS', { min: 500, max: 200_000 }),
      maxAttachmentBytes,
      maxOutputFiles: positiveInt(read(env, 'MAX_OUTPUT_FILES'), 'MAX_OUTPUT_FILES', { min: 1, max: 50 }),
      maxOutputFileBytes: positiveInt(read(env, 'MAX_OUTPUT_FILE_BYTES'), 'MAX_OUTPUT_FILE_BYTES', { min: 1024, max: 2_000_000_000 }),
      perTask: boolean(read(env, 'WORKSPACE_PER_TASK'), 'WORKSPACE_PER_TASK'),
      retentionDays: positiveInt(read(env, 'OUTPUT_RETENTION_DAYS'), 'OUTPUT_RETENTION_DAYS', { min: 0, max: 3650, allowZero: true }),
      alertMb: positiveInt(read(env, 'WORKSPACE_ALERT_MB'), 'WORKSPACE_ALERT_MB', { min: 1, max: 1_000_000 }),
    },
    limits: {
      taskTimeoutMs: positiveInt(read(env, 'TASK_TIMEOUT_MS'), 'TASK_TIMEOUT_MS', { min: 10_000, max: 7_200_000 }),
      dailyTokenLimit: positiveInt(read(env, 'DAILY_TOKEN_LIMIT'), 'DAILY_TOKEN_LIMIT', { min: 0, max: 1_000_000_000, allowZero: true }),
      usageRetentionDays: positiveInt(read(env, 'USAGE_RETENTION_DAYS'), 'USAGE_RETENTION_DAYS', { min: 1, max: 3650 }),
      // 0 turns the per-task ceiling off.
      taskTokenBudget: positiveInt(read(env, 'TASK_TOKEN_BUDGET'), 'TASK_TOKEN_BUDGET', { min: 0, max: 1_000_000_000, allowZero: true }),
      taskTokenWarn: positiveInt(read(env, 'TASK_TOKEN_WARN'), 'TASK_TOKEN_WARN', { min: 0, max: 1_000_000_000, allowZero: true }),
      taskMaxSteps: positiveInt(read(env, 'TASK_MAX_STEPS'), 'TASK_MAX_STEPS', { min: 0, max: 500, allowZero: true }),
      perUserConcurrency: positiveInt(read(env, 'TASK_PER_USER_CONCURRENCY'), 'TASK_PER_USER_CONCURRENCY', { min: 0, max: 50, allowZero: true }),
    },
    queue: {
      store: choice(read(env, 'QUEUE_STORE'), 'QUEUE_STORE', ['jsonl', 'sqlite'], 'jsonl'),
      db: String(read(env, 'QUEUE_DB') ?? '').trim(),
      workers: positiveInt(read(env, 'QUEUE_WORKERS'), 'QUEUE_WORKERS', { min: 1, max: 4 }),
      leaseTtlMs: positiveInt(read(env, 'QUEUE_LEASE_TTL_MS'), 'QUEUE_LEASE_TTL_MS', { min: 1000, max: 3_600_000 }),
    },
    task: {
      cgroup: boolean(read(env, 'TASK_CGROUP'), 'TASK_CGROUP'),
      memoryMaxBytes: positiveInt(read(env, 'TASK_MEMORY_MAX_MB'), 'TASK_MEMORY_MAX_MB', { min: 128, max: 65_536 }) * 1024 * 1024,
      cpuPercent: positiveInt(read(env, 'TASK_CPU_PERCENT'), 'TASK_CPU_PERCENT', { min: 10, max: 800 }),
      pidsMax: positiveInt(read(env, 'TASK_PIDS_MAX'), 'TASK_PIDS_MAX', { min: 16, max: 4096 }),
    },
    model: {
      apiKey: String(env.MODEL_API_KEY ?? '').trim(),
      name: String(read(env, 'MODEL_NAME')),
    },
    disk: {
      enabled: boolean(read(env, 'YANDEX_DISK'), 'YANDEX_DISK'),
      // rest — OAuth-токен приложения; webdav — логин и пароль приложения.
      mode: choice(read(env, 'YANDEX_DISK_MODE'), 'YANDEX_DISK_MODE', ['rest', 'webdav'], 'rest'),
      token: String(env.YANDEX_DISK_TOKEN ?? '').trim(),
      login: String(env.YANDEX_DISK_LOGIN ?? '').trim(),
      password: String(env.YANDEX_DISK_PASSWORD ?? '').trim(),
      dir: String(read(env, 'YANDEX_DISK_DIR')).trim() || '/Агент',
      // A public link is readable by anyone who has it, so it stays opt-in.
      publish: boolean(read(env, 'YANDEX_DISK_PUBLISH'), 'YANDEX_DISK_PUBLISH'),
      timeoutMs: positiveInt(read(env, 'YANDEX_DISK_TIMEOUT_MS'), 'YANDEX_DISK_TIMEOUT_MS', { min: 5000, max: 600_000 }),
    },
    plan: {
      mode: choice(read(env, 'PLAN_MODE'), 'PLAN_MODE', ['auto', 'always', 'never'], 'auto'),
      unattended: boolean(read(env, 'PLAN_UNATTENDED'), 'PLAN_UNATTENDED'),
      minChars: positiveInt(read(env, 'PLAN_MIN_CHARS'), 'PLAN_MIN_CHARS', { min: 20, max: 10_000 }),
      signals: String(env.PLAN_SIGNALS ?? '').trim(),
    },
    routing: {
      mode: choice(read(env, 'ROUTING'), 'ROUTING', ['auto', 'off'], 'auto'),
      maxChars: positiveInt(read(env, 'ROUTER_MAX_CHARS'), 'ROUTER_MAX_CHARS', { min: 20, max: 4000 }),
      // Anything above this length is treated as real work, not a question.
      baseUrl: String(env.ROUTER_BASE_URL ?? '').trim().replace(/\/+$/, '') || String(read(env, 'VISION_BASE_URL')).replace(/\/+$/, ''),
      apiKey: String(env.ROUTER_API_KEY ?? '').trim() || String(env.MODEL_API_KEY ?? '').trim(),
      model: String(read(env, 'ROUTER_MODEL')).trim() || String(read(env, 'MODEL_NAME')).trim(),
      maxTokens: positiveInt(read(env, 'ROUTER_MAX_TOKENS'), 'ROUTER_MAX_TOKENS', { min: 50, max: 8000 }),
      timeoutMs: positiveInt(read(env, 'ROUTER_TIMEOUT_MS'), 'ROUTER_TIMEOUT_MS', { min: 5000, max: 600_000 }),
    },
    spec: {
      repo: String(read(env, 'SPEC_REPO') ?? '').trim() || 'tenkrol/assistant-work',
      dir: String(read(env, 'SPEC_REPO_DIR') ?? '').trim() || '/var/lib/agent/repos/assistant-work',
      keyDir: String(read(env, 'GITHUB_KEY_DIR') ?? '').trim() || '/etc/agent/github',
    },
    agentProfiles: {
      orchestrator: { provider: 'deepseek', model: String(read(env, 'ORCHESTRATOR_MODEL')).trim() || String(read(env, 'MODEL_NAME')).trim() },
      dsh: { provider: 'deepseek', model: String(read(env, 'DSH_MODEL')).trim() || String(read(env, 'MODEL_NAME')).trim() },
      quick: { provider: 'deepseek', model: String(read(env, 'ROUTER_MODEL')).trim() || String(read(env, 'MODEL_NAME')).trim() },
    },
    vision: {
      enabled: boolean(read(env, 'VISION'), 'VISION'),
      baseUrl: String(read(env, 'VISION_BASE_URL')).replace(/\/+$/, ''),
      // A separate key for image calls is optional; the model key is the default.
      apiKey: String(env.VISION_API_KEY ?? '').trim() || String(env.MODEL_API_KEY ?? '').trim(),
      model: String(read(env, 'VISION_MODEL')).trim(),
      maxTokens: positiveInt(read(env, 'VISION_MAX_TOKENS'), 'VISION_MAX_TOKENS', { min: 32, max: 8000 }),
      timeoutMs: positiveInt(read(env, 'VISION_TIMEOUT_MS'), 'VISION_TIMEOUT_MS', { min: 5000, max: 600_000 }),
      maxImageBytes: positiveInt(read(env, 'VISION_MAX_IMAGE_BYTES'), 'VISION_MAX_IMAGE_BYTES', { min: 1024, max: 50_000_000 }),
    },
    ocr: {
      enabled: boolean(read(env, 'OCR'), 'OCR'),
      command: String(read(env, 'OCR_COMMAND')).trim(),
      languages: String(read(env, 'OCR_LANGUAGES')).trim(),
      timeoutMs: positiveInt(read(env, 'OCR_TIMEOUT_MS'), 'OCR_TIMEOUT_MS', { min: 5000, max: 600_000 }),
    },
    dialogue: {
      awaitReplyMs: positiveInt(read(env, 'AWAIT_REPLY_MS'), 'AWAIT_REPLY_MS', { min: 60_000, max: 30 * 24 * 3600 * 1000 }),
      proposeVariants: variantsMode(read(env, 'PROPOSE_VARIANTS')),
      maxVariants: positiveInt(read(env, 'MAX_VARIANTS'), 'MAX_VARIANTS', { min: 2, max: 5 }),
    },
    journal: {
      maxEntries: positiveInt(read(env, 'TASKS_MAX_ENTRIES'), 'TASKS_MAX_ENTRIES', { min: 50, max: 100_000 }),
      actionLog: boolean(read(env, 'ACTION_LOG'), 'ACTION_LOG'),
      actionLogMax: positiveInt(read(env, 'ACTION_LOG_MAX'), 'ACTION_LOG_MAX', { min: 100, max: 100_000 }),
    },
    recovery: {
      notify: boolean(read(env, 'RECOVERY_NOTIFY'), 'RECOVERY_NOTIFY'),
    },
    delivery: {
      tickMs: positiveInt(read(env, 'DELIVERY_TICK_MS'), 'DELIVERY_TICK_MS', { min: 1000, max: 600_000 }),
      retryMs: String(read(env, 'DELIVERY_RETRY_MS')).split(',').map((value) => positiveInt(value.trim(), 'DELIVERY_RETRY_MS', { min: 1000, max: 86_400_000 })),
      maxAttempts: positiveInt(read(env, 'DELIVERY_MAX_ATTEMPTS'), 'DELIVERY_MAX_ATTEMPTS', { min: 1, max: 100 }),
      textChars: positiveInt(read(env, 'DELIVERY_TEXT_CHARS'), 'DELIVERY_TEXT_CHARS', { min: 200, max: 20_000 }),
    },
    files: {
      maxBytes: positiveInt(read(env, 'FILES_MAX_BYTES'), 'FILES_MAX_BYTES', { min: 1024, max: 500_000_000 }),
    },
    procedures: {
      maxVersions: positiveInt(read(env, 'PROCEDURES_MAX_VERSIONS'), 'PROCEDURES_MAX_VERSIONS', { min: 1, max: 200 }),
      retentionDays: positiveInt(read(env, 'PROCEDURES_RETENTION_DAYS'), 'PROCEDURES_RETENTION_DAYS', { min: 1, max: 3650 }),
    },
    memory: {
      contextChars: positiveInt(read(env, 'MEMORY_CONTEXT_CHARS'), 'MEMORY_CONTEXT_CHARS', { min: 200, max: 8000 }),
      historyMax: positiveInt(read(env, 'MEMORY_HISTORY_MAX'), 'MEMORY_HISTORY_MAX', { min: 50, max: 5000 }),
      taskRetentionDays: positiveInt(read(env, 'MEMORY_TASK_RETENTION_DAYS'), 'MEMORY_TASK_RETENTION_DAYS', { min: 0, max: 365, allowZero: true }),
      maxFacts: positiveInt(read(env, 'MEMORY_MAX_FACTS'), 'MEMORY_MAX_FACTS', { min: 10, max: 1000 }),
      secretScan: boolean(read(env, 'MEMORY_SECRET_SCAN'), 'MEMORY_SECRET_SCAN'),
    },
    verify: {
      enabled: boolean(read(env, 'VERIFY'), 'VERIFY'),
      maxAttempts: positiveInt(read(env, 'VERIFY_MAX_ATTEMPTS'), 'VERIFY_MAX_ATTEMPTS', { min: 0, max: 5, allowZero: true }),
      timeoutMs: positiveInt(read(env, 'VERIFY_TIMEOUT_MS'), 'VERIFY_TIMEOUT_MS', { min: 10_000, max: 1_800_000 }),
      render: boolean(read(env, 'VERIFY_RENDER'), 'VERIFY_RENDER'),
      modelMaxChars: positiveInt(read(env, 'VERIFY_MODEL_MAX_CHARS'), 'VERIFY_MODEL_MAX_CHARS', { min: 1000, max: 200_000 }),
      allowlist: String(read(env, 'VERIFY_CHECK_ALLOWLIST')).split(';')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => value.split(/\s+/)),
    },
    voice: {
      stt: {
        provider: choice(read(env, 'STT_PROVIDER'), 'STT_PROVIDER', ['none', 'yandex', 'openai'], 'none'),
        apiKey: String(env.STT_API_KEY ?? '').trim(),
        baseUrl: String(read(env, 'STT_BASE_URL')).replace(/\/+$/, ''),
        model: String(read(env, 'STT_MODEL')).trim(),
        language: String(read(env, 'STT_LANGUAGE')).trim(),
        folderId: String(env.STT_FOLDER_ID ?? '').trim(),
        timeoutMs: positiveInt(read(env, 'STT_TIMEOUT_MS'), 'STT_TIMEOUT_MS', { min: 5000, max: 600_000 }),
        maxBytes: positiveInt(read(env, 'STT_MAX_BYTES'), 'STT_MAX_BYTES', { min: 1024, max: 20_000_000 }),
      },
      tts: {
        provider: choice(read(env, 'TTS_PROVIDER'), 'TTS_PROVIDER', ['none', 'yandex'], 'none'),
        // One SpeechKit key usually covers both directions.
        apiKey: String(env.TTS_API_KEY ?? '').trim() || String(env.STT_API_KEY ?? '').trim(),
        voice: String(read(env, 'TTS_VOICE')).trim() || 'alena',
        speed: numberInRange(read(env, 'TTS_SPEED'), 'TTS_SPEED', { min: 0.1, max: 3 }),
        maxChars: positiveInt(read(env, 'TTS_MAX_CHARS'), 'TTS_MAX_CHARS', { min: 100, max: 5000 }),
        timeoutMs: positiveInt(read(env, 'TTS_TIMEOUT_MS'), 'TTS_TIMEOUT_MS', { min: 5000, max: 600_000 }),
      },
      // auto: answer with a voice note when the request came as one.
      reply: choice(read(env, 'VOICE_REPLY'), 'VOICE_REPLY', ['auto', 'always', 'never'], 'auto'),
      folderId: String(env.STT_FOLDER_ID ?? '').trim(),
    },
    // Связь агент → бот: точка приёма ответов и её токен (секрет).
    outbox: {
      url: String(read(env, 'OUTBOX_URL')),
      token: String(read(env, 'OUTBOX_TOKEN')),
    },
    bridge: {
      // HTTP intake: enabled only when a token is set.
      http: boolean(read(env, 'BRIDGE_HTTP'), 'BRIDGE_HTTP'),
      contractV2: boolean(read(env, 'CONTRACT_V2'), 'CONTRACT_V2'),
      // Маршрут ответа принимается только от настроенного ассистента; пусто — любой.
      routeBotId: String(env.BRIDGE_ROUTE_BOT_ID ?? '').trim(),
      routeChatId: String(env.BRIDGE_ROUTE_CHAT_ID ?? '').trim(),
      bind: String(read(env, 'BRIDGE_BIND')).trim() || '127.0.0.1',
      port: positiveInt(read(env, 'BRIDGE_PORT'), 'BRIDGE_PORT', { min: 1, max: 65_535 }),
      token: String(env.BRIDGE_TOKEN ?? '').trim(),
      maxTaskChars: positiveInt(read(env, 'BRIDGE_MAX_TASK_CHARS'), 'BRIDGE_MAX_TASK_CHARS', { min: 100, max: 20_000 }),
      groupId: String(env.BRIDGE_GROUP_ID ?? '').trim(),
      // Empty means "any bot in that group", which is acceptable there: the group
      // holds the two bots and the owner, and the message must be addressed.
      sourceBotIds: parseUserIds(env.BRIDGE_SOURCE_BOT_IDS),
      notify: boolean(read(env, 'BRIDGE_NOTIFY'), 'BRIDGE_NOTIFY'),
    },
    schedules: {
      enabled: boolean(read(env, 'SCHEDULES'), 'SCHEDULES'),
      tickSec: positiveInt(read(env, 'SCHEDULE_TICK_SEC'), 'SCHEDULE_TICK_SEC', { min: 10, max: 3600 }),
      max: positiveInt(read(env, 'MAX_SCHEDULES'), 'MAX_SCHEDULES', { min: 1, max: 200 }),
      // An empty value means "the same zone as the daily budget".
      timeZone: String(env.SCHEDULE_TIME_ZONE ?? '').trim() || String(env.TIME_ZONE ?? '').trim(),
    },
    // Один блок на все алерты: и «дорого по лимиту» (обработчик лимитов),
    // и автономные триггеры этапа 1. Двух одноимённых ключей быть не должно —
    // в JS побеждает последний, и автономные настройки молча терялись.
    report: {
      // brief — одно итоговое сообщение на задачу (без «приступаю», прогресса и
      // «выполнена»); verbose — прежнее поведение со статусами.
      style: choice(read(env, 'REPORT_STYLE'), 'REPORT_STYLE', ['brief', 'verbose'], 'brief'),
    },
    alerts: {
      chatId: String(env.ALERT_CHAT_ID ?? '').trim(),
      limitPercent: positiveInt(read(env, 'ALERT_ON_LIMIT_PERCENT'), 'ALERT_ON_LIMIT_PERCENT', { min: 1, max: 100 }),
      mode: choice(read(env, 'ALERTS_MODE'), 'ALERTS_MODE', ['dry', 'auto', 'armed'], 'auto'),
      dedupMinutes: positiveInt(read(env, 'ALERT_DEDUP_MIN'), 'ALERT_DEDUP_MIN', { min: 1, max: 10_080 }),
      quietHours: String(read(env, 'ALERT_QUIET_HOURS')).trim(),
      emergencyDiskMb: positiveInt(read(env, 'ALERT_EMERGENCY_DISK_MB'), 'ALERT_EMERGENCY_DISK_MB', { min: 10, max: 1_000_000 }),
      warnDiskMb: positiveInt(read(env, 'ALERT_WARN_DISK_MB'), 'ALERT_WARN_DISK_MB', { min: 10, max: 1_000_000 }),
      errorsPerInterval: positiveInt(read(env, 'ALERT_ERRORS_PER_INTERVAL'), 'ALERT_ERRORS_PER_INTERVAL', { min: 1, max: 100_000 }),
      // Время дневной сводки в минутах от полуночи; off — не отправлять.
      digestAt: clockMinutes(read(env, 'DIGEST_AT'), 'DIGEST_AT'),
    },
    pricing: {
      prices: {
        inputPeak: nonNegativeNumber(read(env, 'PRICE_INPUT_PEAK_PER_M'), 'PRICE_INPUT_PEAK_PER_M'),
        inputOffPeak: nonNegativeNumber(read(env, 'PRICE_INPUT_OFFPEAK_PER_M'), 'PRICE_INPUT_OFFPEAK_PER_M'),
        cachedPeak: nonNegativeNumber(read(env, 'PRICE_CACHED_PEAK_PER_M'), 'PRICE_CACHED_PEAK_PER_M'),
        cachedOffPeak: nonNegativeNumber(read(env, 'PRICE_CACHED_OFFPEAK_PER_M'), 'PRICE_CACHED_OFFPEAK_PER_M'),
        outputPeak: nonNegativeNumber(read(env, 'PRICE_OUTPUT_PEAK_PER_M'), 'PRICE_OUTPUT_PEAK_PER_M'),
        outputOffPeak: nonNegativeNumber(read(env, 'PRICE_OUTPUT_OFFPEAK_PER_M'), 'PRICE_OUTPUT_OFFPEAK_PER_M'),
      },
      windows: String(read(env, 'PEAK_WINDOWS_UTC')),
      weekdaysOnly: boolean(read(env, 'PEAK_WEEKDAYS_ONLY'), 'PEAK_WEEKDAYS_ONLY'),
    },
    runtime: {
      timeZone: String(env.TIME_ZONE ?? '').trim(),
      logLevel: String(read(env, 'LOG_LEVEL')).trim().toLowerCase(),
      sessionContinuity: boolean(read(env, 'SESSION_CONTINUITY'), 'SESSION_CONTINUITY'),
      sessionMaxTokens: positiveInt(read(env, 'SESSION_MAX_TOKENS'), 'SESSION_MAX_TOKENS', { min: 0, max: 10_000_000, allowZero: true }),
      progressIntervalMs: positiveInt(read(env, 'PROGRESS_INTERVAL_MS'), 'PROGRESS_INTERVAL_MS', { min: 5000, max: 600_000 }),
      shutdownGraceMs: positiveInt(read(env, 'SHUTDOWN_GRACE_MS'), 'SHUTDOWN_GRACE_MS', { min: 0, max: 120_000, allowZero: true }),
    },
  }
}

/** The values the logger must never print; deduplicated, since one key may serve both roles. */

export const secretsOf = (config) => [...new Set([
  config.telegram.token,
  config.model.apiKey,
  config.vision.apiKey,
  config.voice.stt.apiKey,
  config.voice.tts.apiKey,
  config.bridge.token,
  config.outbox.token,
  config.disk.token,
  config.disk.password,
].filter(Boolean))]
