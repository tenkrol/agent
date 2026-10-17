/**
 * Рантайм этапа 1: оценить триггеры, применить дедуп/тишину/«стоп» и отправить.
 *
 * Запускается таймером `agent-alerts.timer` каждые 5 минут. Модель не
 * используется: решение принимает чистая функция, поэтому пробуждение стоит
 * ноль токенов. Режим берётся из ALERTS_MODE:
 *
 *   auto  — по умолчанию: пока базовая линия этапа 0 не готова, работает сухой
 *           прогон (триггеры пишутся в журнал, но не отправляются); как только
 *           7 суток набраны, алерты включаются сами;
 *   armed — включены принудительно (для проверки на живых триггерах);
 *   dry   — только журнал, никогда не отправлять.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { loadConfig } from './config/index.mjs'
import { AlertState, classifyErrors, DEFAULT_POLICY, evaluateTriggers, inQuietHours, minutesOfDay, parseQuietHours, renderAlert, renderDigest } from './alerts.mjs'
import { sendTelegram } from './integrations/notify.mjs'
import { baseline, loadObservations, OBSERVATIONS_FILE, readiness } from './observe.mjs'

const logger = {
  info: (message, fields) => console.log(JSON.stringify({ level: 'info', message, ...fields })),
  warn: (message, fields) => console.log(JSON.stringify({ level: 'warn', message, ...fields })),
  error: (message, fields) => console.log(JSON.stringify({ level: 'error', message, ...fields })),
  debug: () => {},
}

/** Чат владельца: явный ALERT_CHAT_ID, иначе первый разрешённый — как в боте. */
const ownerChatId = () => {
  const config = loadConfig()
  return config.alerts.chatId || [...config.telegram.allowedUserIds][0]
}

const dayKey = (date, timeZone) => new Intl.DateTimeFormat('en-CA', {
  timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date)

async function main() {
  const config = loadConfig(process.env)
  const timeZone = config.runtime.timeZone
  const stateDir = config.workspace.stateDir
  const now = new Date()

  const samples = await loadObservations(path.join(stateDir, OBSERVATIONS_FILE))
  const state = await new AlertState({ file: path.join(stateDir, 'alerts.json'), logger }).load()
  if (samples.length === 0) {
    logger.warn('нет наблюдений: сначала должен отработать agent-metrics.timer')
    return
  }

  // Базовую линию считаем по истории БЕЗ текущего замера: иначе залповый рост
  // попадает в собственную норму и триггер сам себя гасит (порог = 5 × p95,
  // где p95 — тот же самый скачок).
  const history = samples.slice(0, -1)
  const base = baseline(history.length > 0 ? history : samples)
  const ready = readiness(samples)
  const policy = {
    ...DEFAULT_POLICY,
    emergencyDiskMb: config.alerts.emergencyDiskMb,
    warnDiskMb: config.alerts.warnDiskMb,
    dedupMinutes: config.alerts.dedupMinutes,
    errorsPerInterval: config.alerts.errorsPerInterval,
  }
  const quiet = parseQuietHours(config.alerts.quietHours)
  const mode = config.alerts.mode
  const armed = mode === 'armed' || (mode === 'auto' && ready.ready)

  const last = samples.at(-1)
  const previous = samples.at(-2)
  const triggers = evaluateTriggers({ sample: last, previous, base, policy, baselineReady: ready.ready })

  const audit = { ts: now.toISOString(), mode, armed, baselineReady: ready.ready, triggers: triggers.map((item) => item.id), sent: [], deferred: [], suppressed: [] }

  for (const trigger of triggers) {
    if (!armed) {
      audit.suppressed.push({ id: trigger.id, reason: mode === 'dry' ? 'режим dry' : 'этап 0 не закрыт' })
      continue
    }
    if (state.stopped && trigger.severity !== 'critical') {
      audit.suppressed.push({ id: trigger.id, reason: 'режим «только алерты»' })
      continue
    }
    if (quiet && trigger.severity !== 'critical' && inQuietHours(minutesOfDay(now, timeZone), quiet)) {
      await state.markSent(trigger, now, { deferred: true })
      audit.deferred.push(trigger.id)
      continue
    }
    const decision = state.shouldSend(trigger, now, policy)
    if (!decision.send) {
      audit.suppressed.push({ id: trigger.id, reason: decision.reason })
      await state.count('dedup')
      continue
    }
    const sent = await sendTelegram({
      token: config.telegram.token,
      chatId: ownerChatId(),
      text: renderAlert(trigger),
    })
    if (sent.ok) {
      await state.markSent(trigger, now)
      audit.sent.push(trigger.id)
      logger.info('алерт отправлен', { id: trigger.id, severity: trigger.severity })
    } else {
      logger.warn('алерт не отправлен', { id: trigger.id, error: sent.error })
    }
  }

  // Дневная сводка: в окне [DIGEST_AT, DIGEST_AT+3ч], один раз в сутки.
  const digestMinutes = config.alerts.digestAt
  const nowMinutes = minutesOfDay(now, timeZone)
  const key = dayKey(now, timeZone)
  const due = digestMinutes !== undefined && nowMinutes >= digestMinutes && nowMinutes <= digestMinutes + 180
  if (due && !state.digestSentOn(key)) {
    const pending = await state.takeQuiet()
    const text = renderDigest({ samples, quiet: pending, now, timeZone })
    const sent = await sendTelegram({ token: config.telegram.token, chatId: ownerChatId(), text })
    if (sent.ok) {
      await state.markDigest(key)
      audit.digest = true
      logger.info('сводка отправлена', { date: key, deferred: pending.length })
    } else {
      logger.warn('сводка не отправлена', { error: sent.error })
    }
  }

  // Классификация ошибок за интервал — для сводки и для этапа 1 в целом.
  const errors = classifyErrors(config.alerts.errorSampleLines ?? [])
  await fs.appendFile(path.join(stateDir, 'alerts.jsonl'), `${JSON.stringify({ ...audit, errors })}\n`, 'utf8')
  logger.info('алерты проверены', {
    triggers: triggers.length, sent: audit.sent.length, deferred: audit.deferred.length,
    suppressed: audit.suppressed.length, armed, baselineReady: ready.ready,
  })
}

main().catch((error) => {
  logger.error('ошибка рантайма алертов', { error: String(error?.stack ?? error).slice(0, 500) })
  process.exitCode = 1
})
