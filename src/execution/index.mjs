/**
 * Домен execution: исполнение задачи.
 *
 * DSH в изолированной cgroup, сборка промпта, разбор ответа, быстрый слой и рабочая папка
 * задачи. Экспортируем всё содержимое модулей домена: ядро берёт нужное по имени.
 */
export * from './dsh-task.mjs'
export * from './cgroup.mjs'
export * from './prompt.mjs'
export * from './reply-protocol.mjs'
export * from './quick.mjs'
export * from './workspace.mjs'
