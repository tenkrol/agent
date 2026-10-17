/**
 * Домен integrations: внешний мир за портами.
 *
 * Telegram Bot API (клиент и порт отправки) и Яндекс.Диск (архив файлов). Сеть вызывается
 * только здесь; остальные домены получают готовые адаптеры.
 */
export { TelegramClient, TelegramError } from './telegram.mjs'
export { TelegramPlatform, createTelegramPlatform, numericId } from './platform.mjs'
export { YandexDisk, YandexWebdav, createDiskStorage, joinPath, formatDiskSize, DEFAULT_API_BASE, DEFAULT_DIR } from './yandex-disk.mjs'
export { sendTelegram } from './notify.mjs'
export { postOutbox } from './outbox.mjs'
