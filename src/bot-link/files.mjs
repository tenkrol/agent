/**
 * Файлы контракта: разбор multipart и метаданные ответа.
 *
 * Только поле `file`. Разбираем вручную: ноль зависимостей, а формат простой —
 * граница из `content-type`, заголовки части, затем байты до следующей границы.
 */
import { ProtocolError } from './protocol.mjs'

/** Граница multipart из заголовка. */
export function multipartBoundary(contentType) {
  const match = String(contentType ?? '').match(/boundary=(?:"([^"]+)"|([^\s;]+))/)
  return match ? (match[1] ?? match[2]) : undefined
}

/**
 * Достать один файл из multipart-тела.
 *
 * @param {Buffer} body - тело запроса.
 * @param {string} contentType - заголовок `content-type`.
 * @returns {{filename: string, mime: string, data: Buffer}} файл.
 */
export function parseMultipartFile(body, contentType) {
  const boundary = multipartBoundary(contentType)
  if (!boundary) throw new ProtocolError(400, 'не найден boundary multipart')
  if (!Buffer.isBuffer(body) || body.length === 0) throw new ProtocolError(400, 'пустое тело загрузки')
  const delimiter = Buffer.from(`--${boundary}`)
  let cursor = body.indexOf(delimiter)
  if (cursor === -1) throw new ProtocolError(400, 'multipart без границы')
  while (cursor < body.length) {
    let start = cursor + delimiter.length
    if (body.slice(start, start + 2).toString() === '--') break
    if (body.slice(start, start + 2).toString() === '\r\n') start += 2
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), start)
    if (headerEnd === -1) throw new ProtocolError(400, 'multipart: нет заголовков части')
    const headers = body.slice(start, headerEnd).toString('utf8')
    const dataStart = headerEnd + 4
    const next = body.indexOf(delimiter, dataStart)
    if (next === -1) throw new ProtocolError(400, 'multipart: нет закрывающей границы')
    let dataEnd = next
    if (body[dataEnd - 2] === 13 && body[dataEnd - 1] === 10) dataEnd -= 2
    const nameMatch = headers.match(/name="([^"]*)"/)
    if (nameMatch?.[1] === 'file') {
      const filenameMatch = headers.match(/filename="([^"]*)"/)
      const typeMatch = headers.match(/content-type:\s*([^\r\n]+)/i)
      if (dataStart > dataEnd) throw new ProtocolError(400, 'пустой файл')
      return {
        filename: filenameMatch ? filenameMatch[1] : 'file',
        mime: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
        data: body.slice(dataStart, dataEnd),
      }
    }
    cursor = next
  }
  throw new ProtocolError(400, 'в multipart нет поля file')
}

/** Публичные метаданные файла для ответа/события. */
export function fileMeta(record) {
  return {
    fileId: record.fileId,
    name: record.name,
    size: record.size,
    mime: record.mime,
  }
}
