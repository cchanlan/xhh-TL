import fs from 'fs'
import path from 'path'
import sharp from 'sharp'

import { getRenderScale } from './pluginConfig.js'

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

/**
 * Upscale the complete rendered image after capture, so CSS layout and crop bounds
 * remain untouched. Lanczos3 plus mild sharpening improves text/icon edge clarity.
 */
export async function enhanceRenderImage(result, config = {}, options = {}) {
  const input = extractRenderBuffer(result)
  if (!input) return null

  const scale = Number(options.scale ?? getRenderScale(config))
  let pipeline = sharp(input, { failOn: 'none' })
  const meta = await pipeline.metadata()

  if (scale > 1 && meta.width && meta.height) {
    pipeline = pipeline
      .resize({
        width: Math.max(1, Math.round(meta.width * scale)),
        height: Math.max(1, Math.round(meta.height * scale)),
        fit: 'fill',
        kernel: sharp.kernel.lanczos3,
      })
      .sharpen({ sigma: 0.65 })
  }

  return pipeline
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toBuffer()
}
