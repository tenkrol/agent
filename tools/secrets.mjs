#!/usr/bin/env node
/**
 * Обёртка: реализация переехала в домен `src/secrets/`.
 *
 * Интерфейс не изменился: `node tools/secrets.mjs encrypt|decrypt|check`.
 */
import '../src/secrets/cli.mjs'
