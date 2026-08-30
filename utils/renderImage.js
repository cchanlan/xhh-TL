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

/** sharp 是主仓库自带的，缺了也要能出图——那就原样发渲染器给的图 */
let sharpMod
async function getSharp() {
  if (sharpMod !== undefined) return sharpMod
  try {
    sharpMod = (await import('sharp')).default
  } catch (err) {
    logger?.debug?.(`[xhh-TL][出图] sharp 不可用，图片不再二次压缩：${err.message}`)
    sharpMod = null
  }
  return sharpMod
}

/**
 * 把渲染器出的无损 png 压成 webp。
 *
 * 让渲染器直接出 jpeg 的话用的是 Chromium 内置编码器，同画质比 webp 大不少；
 * png 是无损的，所以这一步二次编码不会累积失真。实测同一张抽卡记录图
 * scale 更高的 webp 反而比原来的 jpeg 更小（webp q82 视觉上相当于 jpeg q90+）。
 * 压不动（sharp 缺失、或者传进来的本来就不是 png）就原样返回，不影响出图。
 */
export async function toWebp(buffer, quality = 82) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return buffer
  const sharp = await getSharp()
  if (!sharp) return buffer
  try {
    return await sharp(buffer).webp({ quality }).toBuffer()
  } catch (err) {
    logger?.debug?.(`[xhh-TL][出图] webp 压缩失败，用原图：${err.message}`)
    return buffer
  }
}
