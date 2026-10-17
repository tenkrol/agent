/**
 * Домен tools: инструменты агента.
 *
 * Вложения, текст из документов, распознавание картинок и сканов, голос. Сетевые провайдеры
 * получают HTTP-клиент портом (`fetchImpl`) — прямого обращения к сети домен не делает.
 */
export * from './inbox.mjs'
export * from './extract.mjs'
export * from './vision.mjs'
export * from './ocr.mjs'
export * from './stt.mjs'
export * from './tts.mjs'
