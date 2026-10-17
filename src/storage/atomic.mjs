/**
 * Общая запись состояния: атомарно и с сохранением копии битого файла.
 *
 * Все файлы состояния домена пишутся только отсюда — так сбой посреди записи не
 * оставляет частичный файл, а повреждённый файл не исчезает бесследно.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** Записать текст атомарно: временный файл рядом + переименование. */
export async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(temporary, text, 'utf8')
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return file
}

/** Отложить повреждённый файл в копию с датой; вернуть путь копии. */
export async function quarantineCorrupt(file, { now = new Date(), logger } = {}) {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const target = `${file}.corrupt-${stamp}`
  try {
    await fs.copyFile(file, target)
    logger?.warn('состояние отложено в копию', { file, copy: target })
    return target
  } catch (error) {
    logger?.error('не удалось отложить повреждённый файл', { file, error })
    return undefined
  }
}
