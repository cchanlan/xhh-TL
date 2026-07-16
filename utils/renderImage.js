import fs from 'fs'
import path from 'path'

/** Extract an image buffer from the return shapes used by different Yunzai runtimes. */
export function extractRenderBuffer(result) {
  if (Buffer.isBuffer(result)) return result

  if (Buffer.isBuffer(result?.image)) return result.image
  if (Buffer.isBuffer(result?.buffer)) return result.buffer

  const value = result?.file ?? result
  if (Buffer.isBuffer(value)) return value
  if (typeof value !== 'string') return null

  if (value.startsWith('base64://')) return Buffer.from(value.slice(9), 'base64')
  if (value.startsWith('data:image')) {
    const comma = value.indexOf(',')
    if (comma >= 0) return Buffer.from(value.slice(comma + 1), 'base64')
  }
  if (value.length > 256 && /^[A-Za-z0-9+/=\r\n]+$/.test(value)) {
    try {
      return Buffer.from(value, 'base64')
    } catch (_) {}
  }

  const file = value.replace(/^file:\/\//, '')
  for (const candidate of [file, path.resolve(file), path.resolve(process.cwd(), file)]) {
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate)
    } catch (_) {}
  }
  return null
}
