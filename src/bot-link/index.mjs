/**
 * Домен bot-link: связь с чат-ботом.
 *
 * Вход — приём задач (bridge-http), выход — зеркалирование ответа (mirror). Транспорт
 * (fetch, HTTP-сервер) — в integrations и здесь только для приёма на loopback.
 */
export * from './bridge-http.mjs'
export * from './mirror.mjs'
