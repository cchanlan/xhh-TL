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

/** sharp 在不在（决定渲染器该直接出目标格式，还是出无损 png 交给这里编码） */
export async function hasSharp() {
  return !!(await getSharp())
}

/**
 * 按目标格式编码一张图：jpeg / png / webp。
 *
 * 渲染器本身只能出它内置编码器的结果，所以统一走「渲染器出无损 png → 这里二次编码」，
 * 和格式无关的那部分逻辑（圆角裁切后也复用这里）就能只写一遍。
 *
 * jpeg 优先用 mozjpeg（同画质实测小约 18%）：这选项依赖 sharp 编译时带上 mozjpeg，
 * 个别平台 / 自编译的 sharp 会直接抛错，所以失败退回普通编码器 ——
 * 不能让一个「更小」的优化把整张图搞没。
 *
 * @param {Buffer} buffer 源图（无损 png 最理想，二次编码不累积失真）
 * @param {{imgType?:'jpeg'|'png'|'webp', quality?:number}} opts 目标格式，默认 jpeg
 * @returns {Promise<Buffer>} 编码失败 / sharp 缺失时原样返回源图
 */
export async function encodeImage(buffer, { imgType = 'jpeg', quality = 82 } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return buffer
  const sharp = await getSharp()
  if (!sharp) return buffer
  const type = imgType === 'jpg' ? 'jpeg' : imgType
  try {
    // png 是无损的，质量参数对它没有意义，别把 quality 传进去
    if (type === 'png') return await sharp(buffer).png().toBuffer()
    if (type === 'webp') return await sharp(buffer).webp({ quality }).toBuffer()
    try {
      return await sharp(buffer).jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer()
    } catch (_) {
      return await sharp(buffer).jpeg({ quality, chromaSubsampling: '4:4:4' }).toBuffer()
    }
  } catch (err) {
    logger?.debug?.(`[xhh-TL][出图] 转 ${type} 失败，用原图：${err.message}`)
    return buffer
  }
}

/**
 * 把图片四角切成圆角、圆角外透明（出图模板的卡片要「透出群背景」时用）。
 *
 * 为什么不用 CSS + 渲染器：Yunzai 的渲染器截图不支持 omitBackground，
 * body 透明也会被截成白底或黑底；把 body 填成卡片同色又会「吃掉」底部圆角
 * （圆角外跟卡片一个颜色，看起来就是直角）。所以出图后在插件侧用 sharp 裁。
 *
 * 半径按图片宽度等比换算（模板按 620rem 宽设计，圆角 34rem）。
 * sharp 缺失或出错就原样返回，不影响出图。
 *
 * ⚠️ 输出格式跟随「输出图片类型」配置，默认 webp。
 * 别写死 .png()：那会把上游刚压好的图**重新膨胀回无损**，
 * 实测同尺寸卡片 webp 6.7KB → png 45KB（12 倍），群里发图又慢又费流量。
 *
 * ⚠️ **jpeg 没有透明通道**：圆角外那圈透明会被编码成黑角（白角也难看）。
 * 用户选 jpeg 时就不裁了，给回原来的直角矩形 —— 渲染器出的本来就是矩形卡片，
 * 直角不难看，总比四角糊一团黑强。
 *
 * @param {Buffer} buffer 源图
 * @param {number} [opts.quality]     webp 质量，默认 82；传 false 强制出 png
 * @param {string} [opts.imgType]     目标格式 jpeg/png/webp，默认 webp
 */
export async function roundCorners(buffer, { radius = 34, baseWidth = 620, quality = 82, imgType = 'webp' } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return buffer
  const sharp = await getSharp()
  if (!sharp) return buffer
  // jpeg 装不下透明通道，裁了只会得到四个黑角，不如不裁
  const type = quality === false ? 'png' : imgType
  if (type === 'jpeg' || type === 'jpg') {
    logger?.debug?.('[xhh-TL][出图] 当前是 JPEG，跳过圆角裁切（JPEG 无透明通道，裁了会出黑角）')
    return buffer
  }
  try {
    const img = sharp(buffer)
    const meta = await img.metadata()
    const w = meta.width || 0
    const h = meta.height || 0
    if (!w || !h) return buffer
    const r = Math.max(0, Math.round((radius / baseWidth) * w))
    if (r <= 0) return buffer
    // 用 alpha 通道做遮罩：白底 + 黑色圆角矩形，取 alpha 与原图相乘
    const mask = Buffer.from(
      `<svg width="${w}" height="${h}"><rect x="0" y="0" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`,
    )
    const cut = await img.ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer()
    return await encodeImage(cut, { imgType: type, quality })
  } catch (err) {
    logger?.debug?.(`[xhh-TL][出图] 圆角裁切失败，用原图：${err.message}`)
    return buffer
  }
}

/**
 * 把渲染器出的无损 png 压成 webp（兼容旧调用点，新代码请直接用 encodeImage）。
 *
 * 让渲染器直接出 jpeg 的话用的是 Chromium 内置编码器，同画质比 webp 大不少；
 * png 是无损的，所以这一步二次编码不会累积失真。实测同一张抽卡记录图
 * scale 更高的 webp 反而比原来的 jpeg 更小（webp q82 视觉上相当于 jpeg q90+）。
 * 压不动（sharp 缺失、或者传进来的本来就不是 png）就原样返回，不影响出图。
 */
export async function toWebp(buffer, quality = 82) {
  return encodeImage(buffer, { imgType: 'webp', quality })
}
