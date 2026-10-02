/** 立绘自适应配色：小图六色中位切分，不依赖 Python，也不联网取图。 */
import fs from 'fs'
import { fileURLToPath } from 'url'
import { resolvePluginPath } from './pluginConfig.js'

const cache = new Map()
const CACHE_LIMIT = 64
let sharpPromise

function describeBox(pixels) {
  const low = [255, 255, 255], high = [0, 0, 0]
  for (const pixel of pixels) {
    for (let c = 0; c < 3; c++) {
      low[c] = Math.min(low[c], pixel[c])
      high[c] = Math.max(high[c], pixel[c])
    }
  }
  const ranges = high.map((value, c) => (value - low[c]) * [0.299, 0.587, 0.114][c])
  const range = Math.max(...ranges)
  return { pixels, range, axis: ranges.indexOf(range) }
}

// 按像素数量优先切分，沿加权跨度最大的通道分为两半，再按最近色重新统计面积。
// 同人口优先细分色域更集中的盒，再以高色值半盒保持稳定次序；不按饱和度挑色。
// 与 Pillow 同为六色中位切分，但缩略核、切盒细节不完全相同，色值可能有小幅差异。
function dominantColor(pixels) {
  const boxes = [describeBox(pixels)]
  while (boxes.length < 6) {
    boxes.sort((a, b) => b.pixels.length - a.pixels.length || a.range - b.range)
    const index = boxes.findIndex(box => box.range > 0 && box.pixels.length > 1)
    if (index < 0) break
    const box = boxes.splice(index, 1)[0]
    box.pixels.sort((a, b) => a[box.axis] - b[box.axis])
    const middle = Math.floor(box.pixels.length / 2)
    boxes.push(describeBox(box.pixels.slice(middle)), describeBox(box.pixels.slice(0, middle)))
  }
  const colors = boxes.map(box => {
    const sum = [0, 0, 0]
    for (const pixel of box.pixels) for (let c = 0; c < 3; c++) sum[c] += pixel[c]
    return sum.map(value => Math.round(value / box.pixels.length))
  })
  const counts = colors.map(() => 0)
  for (const pixel of pixels) {
    let nearest = 0, minimum = Infinity
    for (let i = 0; i < colors.length; i++) {
      const distance = colors[i].reduce((sum, value, c) => sum + (value - pixel[c]) ** 2, 0)
      if (distance < minimum) { minimum = distance; nearest = i }
    }
    counts[nearest]++
  }
  return colors[counts.indexOf(Math.max(...counts))]
}

function makePalette(rgb) {
  const [r, g, b] = rgb.map(value => value / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const delta = max - min, light = (max + min) / 2
  let hue = 0, saturation = 0
  if (delta) {
    saturation = delta / (1 - Math.abs(2 * light - 1))
    hue = (max === r ? (g - b) / delta + (g < b ? 6 : 0)
      : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) / 6
  }
  const tone = (l, s = Math.max(0.16, Math.min(saturation, 0.30))) => {
    const chroma = (1 - Math.abs(2 * l - 1)) * s
    const x = chroma * (1 - Math.abs((hue * 6) % 2 - 1)), m = l - chroma / 2
    const channels = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x],
      [0, x, chroma], [x, 0, chroma], [chroma, 0, x]][Math.floor(hue * 6) % 6]
    return '#' + channels.map(value => Math.round((value + m) * 255).toString(16).padStart(2, '0')).join('')
  }
  return Object.freeze({ top: tone(0.40), bottom: tone(0.26), accent: tone(0.84, 0.45) })
}

async function readPalette(abs) {
  try {
    if (!sharpPromise) sharpPromise = import('sharp').then(module => module.default).catch(() => null)
    const sharp = await sharpPromise
    if (!sharp) return null
    const { data, info } = await sharp(abs)
      .resize(80, 80, { fit: 'inside', withoutEnlargement: true, kernel: 'cubic', fastShrinkOnLoad: false })
      .toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const pixels = []
    for (let i = 0; i < data.length; i += info.channels) {
      // 不让透明抠图的隐藏 RGB / 黑色填充值参与取色。
      if (data[i + 3] >= 128) pixels.push([data[i], data[i + 1], data[i + 2]])
    }
    return pixels.length ? makePalette(dominantColor(pixels)) : null
  } catch (error) {
    if (typeof logger !== 'undefined') logger.debug?.(`[xhh-TL] 立绘取色失败，沿用默认配色: ${error.message}`)
    return null
  }
}

/**
 * 本地路径 / file URL → { top, bottom, accent }；不支持的输入或失败返回 null。
 * 64 条 LRU 缓存以路径、修改时间及大小区分版本；并发请求共享取色 Promise。
 * Linux 已实测；路径解析和可选 sharp 加载复用跨平台接口，Windows 尚未实跑。
 */
export async function getPortraitPalette(input) {
  if (typeof input !== 'string' || !input.trim() || /^(?:https?:|data:)/i.test(input)) return null
  try {
    const abs = input.startsWith('file://') ? fileURLToPath(input) : resolvePluginPath(input)
    if (!abs) return null
    const stat = await fs.promises.stat(abs)
    if (!stat.isFile()) return null
    const key = `${abs}:${stat.mtimeMs}:${stat.size}`
    if (cache.has(key)) {
      const pending = cache.get(key)
      cache.delete(key)
      cache.set(key, pending)
      return pending
    }
    const pending = readPalette(abs)
    cache.set(key, pending)
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
    return pending
  } catch (_) {
    return null
  }
}
