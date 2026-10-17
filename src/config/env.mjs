/**
 * Значения по умолчанию и чтение окружения — единственное место с process.env.
 */
export const DEFAULTS = {
  TELEGRAM_API_BASE: 'https://api.telegram.org',
  ALLOW_ALL_USERS: 'false',
  DENY_MESSAGE: 'Доступ закрыт. Ваш ID: {id}. Передайте его владельцу бота.',

  // Where the DSH runtime lives on this server.
  DSH_BIN: '/usr/local/bin/dsh',
  DSH_PROFILE: 'headless',
  DSH_HOME: '/var/lib/agent/dsh',
  DSH_PERMISSION_MODE: 'workspace-write',

  // Where the agent works and keeps its own state.
  WORKSPACE_DIR: '/var/lib/agent/workspace',
  STATE_DIR: '/var/lib/agent/state',

  // Task limits. The daily budget is in tokens, the timeout in milliseconds.
  TASK_TIMEOUT_MS: '1200000',
  // A ceiling on one run's tokens (a looping model re-sends its context every
  // step) and the level at which the answer says "this one was expensive".
  TASK_TOKEN_BUDGET: '1500000',
  TASK_TOKEN_WARN: '300000',
  // Предел шагов на задачу: расход ≈ шаги × контекст.
  TASK_MAX_STEPS: '16',
  DAILY_TOKEN_LIMIT: '3000000',
  MAX_TASK_CHARS: '8000',
  MAX_ANSWER_CHARS: '20000',
  MAX_ATTACHMENT_BYTES: '20000000',
  MAX_OUTPUT_FILES: '8',
  MAX_OUTPUT_FILE_BYTES: '45000000',
  OUTPUT_RETENTION_DAYS: '14',

  // Behaviour.
  SESSION_CONTINUITY: 'true',
  // Предел накопленного контекста беседы: выше него следующая задача начинается
  // с чистой сессии. DSH сжимает историю слишком поздно (проверено: ранняя
  // компакция в headless-профиле не срабатывает), поэтому режем сами.
  SESSION_MAX_TOKENS: '60000',
  PROGRESS_INTERVAL_MS: '60000',
  POLL_TIMEOUT_SEC: '30',
  TELEGRAM_TIMEOUT_MS: '60000',
  USAGE_RETENTION_DAYS: '60',
  // Восстановление после перезапуска: сообщать о принятых/прерванных задачах и вести
  // журнал внешних действий, чтобы не повторять их при неизвестном исходе.
  RECOVERY_NOTIFY: 'true',
  ACTION_LOG: 'true',
  ACTION_LOG_MAX: '5000',

  // Контракт v2 и доставка: маршрут ассистента, повторы, предел файла.
  CONTRACT_V2: 'true',
  BRIDGE_ROUTE_BOT_ID: '',
  BRIDGE_ROUTE_CHAT_ID: '',
  DELIVERY_TICK_MS: '30000',
  DELIVERY_RETRY_MS: '60000,300000,900000,3600000,21600000',
  DELIVERY_MAX_ATTEMPTS: '8',
  DELIVERY_TEXT_CHARS: '3500',

  // Проверка результата (PLA-15). Allowlist — argv-команды через «;», без оболочки.
  VERIFY: 'true',
  VERIFY_MAX_ATTEMPTS: '1',
  VERIFY_TIMEOUT_MS: '300000',
  VERIFY_RENDER: 'true',
  VERIFY_MODEL_MAX_CHARS: '12000',
  VERIFY_CHECK_ALLOWLIST: 'node --test;npm test;npm run lint;npm run build;pytest;go test;cargo test;make test',

  // Личные процедуры (PLA-16).
  PROCEDURES_MAX_VERSIONS: '20',
  PROCEDURES_RETENTION_DAYS: '365',
  FILES_MAX_BYTES: '20971520',

  // Model: the key is forwarded to DSH as DEEPSEEK_API_KEY before each run.
  MODEL_API_KEY: '',
  MODEL_NAME: 'deepseek-flash',

  // Images: a vision call turns a photo into task text before DSH runs.
  VISION: 'true',
  VISION_BASE_URL: 'https://api.deepseek.com/v1',
  VISION_API_KEY: '',
  VISION_MODEL: 'deepseek-chat',
  VISION_MAX_TOKENS: '900',
  VISION_TIMEOUT_MS: '90000',
  VISION_MAX_IMAGE_BYTES: '8000000',

  // Local OCR fallback: tesseract, used when vision is unavailable.
  OCR: 'true',
  OCR_COMMAND: 'tesseract',
  OCR_LANGUAGES: 'rus+eng',
  OCR_TIMEOUT_MS: '60000',

  // Dialogue with a task: how long an answer is awaited, when to offer variants.
  AWAIT_REPLY_MS: '86400000',
  PROPOSE_VARIANTS: 'auto',
  MAX_VARIANTS: '3',

  // Voice: SpeechKit transcribes incoming notes and can read an answer aloud.
  STT_PROVIDER: 'none',
  STT_API_KEY: '',
  STT_BASE_URL: 'https://api.openai.com/v1',
  STT_MODEL: 'whisper-1',
  STT_LANGUAGE: 'ru-RU',
  STT_FOLDER_ID: '',
  STT_TIMEOUT_MS: '60000',
  STT_MAX_BYTES: '1000000',
  TTS_PROVIDER: 'none',
  TTS_API_KEY: '',
  TTS_VOICE: 'alena',
  TTS_SPEED: '1.0',
  TTS_MAX_CHARS: '1200',
  TTS_TIMEOUT_MS: '60000',
  VOICE_REPLY: 'auto',

  // Quick layer: answer a trivial request with one small model call instead of
  // a full DSH run (~7k tokens and ~5 s of overhead).
  ROUTING: 'auto',
  ROUTER_MAX_CHARS: '240',
  ROUTER_BASE_URL: '',
  ROUTER_MODEL: '',
  ROUTER_MAX_TOKENS: '700',
  ROUTER_TIMEOUT_MS: '60000',

  // Сколько сообщений получает владелец на одну задачу.
  REPORT_STYLE: 'brief',

  // Этап 1: алерты. auto — включить сами, когда этап 0 наберёт базовую линию.
  ALERTS_MODE: 'auto',
  ALERT_DEDUP_MIN: '60',
  ALERT_QUIET_HOURS: '23:00-07:30',
  ALERT_EMERGENCY_DISK_MB: '300',
  ALERT_WARN_DISK_MB: '1024',
  ALERT_ERRORS_PER_INTERVAL: '20',
  DIGEST_AT: '08:00',

  // Yandex.Disk: the archive of everything the agent produces.
  YANDEX_DISK: 'false',
  YANDEX_DISK_MODE: 'rest',
  YANDEX_DISK_TOKEN: '',
  // WebDAV (режим webdav): логин Яндекса и пароль приложения.
  YANDEX_DISK_LOGIN: '',
  YANDEX_DISK_PASSWORD: '',
  YANDEX_DISK_DIR: '/Агент',
  YANDEX_DISK_PUBLISH: 'false',
  YANDEX_DISK_TIMEOUT_MS: '60000',

  // Plan mode: for work that looks big, show a plan and wait for approval before
  // spending a real run on it.
  PLAN_MODE: 'auto',
  PLAN_MIN_CHARS: '200',
  PLAN_SIGNALS: '',
  // Тихий план для задач из моста и по расписанию: утверждать его некому,
  // но он не даёт исполнителю блуждать.
  PLAN_UNATTENDED: 'true',

  // Bridge: a loopback HTTP endpoint the chat bot reaches through an SSH tunnel.
  BRIDGE_HTTP: 'true',
  BRIDGE_BIND: '127.0.0.1',
  BRIDGE_PORT: '8787',
  BRIDGE_TOKEN: '',
  BRIDGE_MAX_TASK_CHARS: '4000',
  // Точка приёма ответов в чат-боте (связь агент → бот).
  OUTBOX_URL: 'http://127.0.0.1:8788/outbox',
  OUTBOX_TOKEN: '',

  // The Telegram group stays as a manual entry point for the owner.
  BRIDGE_GROUP_ID: '',
  BRIDGE_SOURCE_BOT_IDS: '',
  BRIDGE_NOTIFY: 'true',

  // Recurring tasks: the agent's own scheduler (cron in the owner's time zone).
  SCHEDULES: 'true',
  SCHEDULE_TICK_SEC: '60',
  MAX_SCHEDULES: '20',

  // Per-task resource limits (a delegated cgroup; see src/cgroup.mjs).
  TASK_CGROUP: 'true',
  TASK_MEMORY_MAX_MB: '1500',
  TASK_CPU_PERCENT: '150',
  TASK_PIDS_MAX: '256',
  WORKSPACE_ALERT_MB: '2048',

  // Journal, alerts and the money estimate.
  TASKS_MAX_ENTRIES: '2000',
  ALERT_CHAT_ID: '',
  ALERT_ON_LIMIT_PERCENT: '80',
  PRICE_INPUT_PEAK_PER_M: '0.3',
  PRICE_INPUT_OFFPEAK_PER_M: '0.15',
  PRICE_CACHED_PEAK_PER_M: '0.006',
  PRICE_CACHED_OFFPEAK_PER_M: '0.003',
  PRICE_OUTPUT_PEAK_PER_M: '1.2',
  PRICE_OUTPUT_OFFPEAK_PER_M: '0.6',
  PEAK_WINDOWS_UTC: '01:00-04:00,06:00-10:00',
  PEAK_WEEKDAYS_ONLY: 'true',

  TIME_ZONE: '',
  LOG_LEVEL: 'info',
  SHUTDOWN_GRACE_MS: '10000',
}

export const read = (env, key) => {
  const value = env[key]
  return value === undefined || value === '' ? DEFAULTS[key] : value
}
