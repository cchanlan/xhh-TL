/**
 * Nanoka 版本深渊 / 挑战查询
 * 数据：static.nanoka.cc（与 #幻想剧诗 同源）
 * - 原神：深境螺旋 tower + 幻想剧诗 rolecombat
 * - 星铁：maze 挑战库（混沌等回忆向挑战线）
 * 渲染：nanoka 风格深色门户卡片
 *
 * 指令示例：
 *   #版本深渊 / #下期深渊 / #版本剧诗 / #下期剧诗 / #版本危战 / #下期危战
 *   *版本混沌 / *下期混沌     → maze 混沌回忆
 *   *版本虚构 / *下期虚构     → maze_extra 虚构叙事
 *   *版本末日 / *下期末日     → maze_boss 末日幻影
 *   *版本异相 / *下期异相     → maze_peak 异相仲裁
 *   期数：最大 id=下期，第二大=正式；层数高→低
 */

import fetch from 'node-fetch'
import moment from 'moment'
import path from 'path'
import fs from 'fs'
import sharp from 'sharp'
import plugin from '../../../lib/plugins/plugin.js'
import { getRenderScaleStyle, readPluginConfig } from '../utils/pluginConfig.js'
import { replyProgress, replyQuote } from '../utils/replyHelper.js'

const MANIFEST_URL = 'https://static.nanoka.cc/manifest.json'
const STATIC = 'https://static.nanoka.cc'

/**
 * 图标名 → 候选 URL
 * 注意：upload-bbs.miyoushe.com 对不存在资源会返回「灰白占位图」(HTTP 200)，
 * 不能当有效图源，仅作最后尝试。
 *
 * 优先用 Nanoka 自托管资源（与网页同源）：
 * - GI:  https://static.nanoka.cc/assets/gi/UI_MonsterIcon_xxx.webp
 * - HSR: https://static.nanoka.cc/assets/hsr/monstermiddleicon/Monster_xxx.webp
 */
function iconCandidates(icon, game = 'gi') {
  if (!icon) return []
  const s = String(icon)
  if (s.startsWith('data:')) return [s]
  if (s.startsWith('http')) return [s]
  // 去掉可能的扩展名与路径（HSR: SpriteOutput/MonsterFigure/Monster_xxx.png）
  const base = s.replace(/\\/g, '/').split('/').pop() || s
  const name = base.replace(/\.(png|webp|jpg)$/i, '')
  const list = []
  const gameKey = game === 'hsr' ? 'hsr' : 'gi'

  if (gameKey === 'hsr') {
    // 网页实际路径：assets/hsr/monstermiddleicon/${iconFile}
    list.push(`https://static.nanoka.cc/assets/hsr/monstermiddleicon/${name}.webp`)
    list.push(`https://static.nanoka.cc/assets/hsr/monstermiddleicon/${name}.png`)
    list.push(`https://static.nanoka.cc/assets/hsr/${name}.webp`)
    list.push(`https://static.nanoka.cc/assets/hsr/${name}.png`)
  } else {
    list.push(`https://static.nanoka.cc/assets/gi/${name}.webp`)
    list.push(`https://static.nanoka.cc/assets/gi/${name}.png`)
    // yatta（老怪稳定）
    list.push(`https://gi.yatta.moe/assets/UI/monster/${name}.png`)
  }

  // 其它兜底
  if (name.includes('SpriteOutput') || s.includes('/')) {
    list.push(`https://upload-bbs.miyoushe.com/upload/${s.replace(/^\//, '')}`)
  }
  list.push(`https://enka.network/ui/${name}.png`)
  return list
}

/** icon 名或 URL → dataURI 缓存 */
const iconDataCache = new Map()

async function fetchIconBuffer(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Referer: url.includes('nanoka')
          ? url.includes('/hsr/') || url.includes('assets/hsr')
            ? 'https://hsr.nanoka.cc/'
            : 'https://gi.nanoka.cc/'
          : url.includes('yatta')
            ? 'https://gi.yatta.moe/'
            : 'https://www.miyoushe.com/',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length < 200) return null
    // PNG / JPEG / WebP(RIFF....WEBP) / GIF
    const isPng = buf[0] === 0x89 && buf[1] === 0x50
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8
    const isGif = buf.slice(0, 3).toString() === 'GIF'
    const isWebp =
      buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP'
    const isRiff = buf.slice(0, 4).toString() === 'RIFF'
    if (!(isPng || isJpg || isGif || isWebp || isRiff)) return null
    return buf
  } catch (_) {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 判定是否为米游社灰白占位图（几乎全白） */
async function isPlaceholderImage(buf) {
  try {
    const { data, info } = await sharp(buf)
      .resize(32, 32, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    let sum = 0
    let n = 0
    for (let i = 0; i < data.length; i += 4) {
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3
      n++
    }
    const avg = sum / Math.max(1, n)
    // 灰白占位平均亮度极高
    return avg > 230
  } catch (_) {
    return false
  }
}

/** 用名字生成彩色圆头（当所有 CDN 都失败时） */
async function makeNameBadge(name = '怪') {
  const label = String(name || '怪').replace(/\s+/g, '').slice(0, 2) || '怪'
  // 简单 hash 选色
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0
  const hue = h % 360
  const bg = `hsl(${hue} 55% 42%)`
  const svg = `
  <svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${bg}"/>
        <stop offset="100%" stop-color="hsl(${(hue + 40) % 360} 50% 28%)"/>
      </linearGradient>
    </defs>
    <circle cx="128" cy="128" r="128" fill="url(#g)"/>
    <circle cx="128" cy="128" r="120" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="5"/>
    <text x="128" y="145" text-anchor="middle" font-size="72" font-weight="700"
      font-family="Noto Sans SC, Microsoft YaHei, sans-serif" fill="#fff">${label}</text>
  </svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

/**
 * @param {string} icon 图标名或 URL
 * @param {string} [name] 怪物名，用于失败时生成角标
 * @param {string} [game] gi | hsr
 */
async function iconToDataUri(icon, name = '', game = 'gi') {
  if (!icon && !name) return ''
  if (String(icon || '').startsWith('data:')) return icon
  const cacheKey = `${game}|${icon || ''}|${name || ''}`
  if (iconDataCache.has(cacheKey)) return iconDataCache.get(cacheKey)

  const urls = iconCandidates(icon, game)
  for (const url of urls) {
    const buf = await fetchIconBuffer(url)
    if (!buf) continue
    if (await isPlaceholderImage(buf)) continue
    let out = buf
    try {
      out = await sharp(buf)
        .resize(256, 256, { fit: 'cover', position: 'centre', kernel: sharp.kernel.lanczos3 })
        .png()
        .toBuffer()
    } catch (_) {
      // sharp 解码失败则跳过该源
      continue
    }
    // 再挡一次 resize 后的白图
    if (await isPlaceholderImage(out)) continue
    const uri = `data:image/png;base64,${out.toString('base64')}`
    iconDataCache.set(cacheKey, uri)
    return uri
  }

  // 全部失败 → 名字色块
  try {
    const badge = await makeNameBadge(name || icon || '怪')
    const uri = `data:image/png;base64,${badge.toString('base64')}`
    iconDataCache.set(cacheKey, uri)
    return uri
  } catch (_) {
    iconDataCache.set(cacheKey, '')
    return ''
  }
}

async function hydrateIcons(data) {
  const game = data?.game === 'hsr' ? 'hsr' : 'gi'
  const targets = []
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) {
      obj.forEach(walk)
      return
    }
    if (typeof obj.icon === 'string' && obj.icon && !obj.icon.startsWith('data:')) {
      targets.push(obj)
    } else if (obj.name && (obj.icon === '' || obj.icon == null) && (obj.id || obj.level != null)) {
      // 无 icon 也做角标
      targets.push(obj)
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') walk(v)
    }
  }
  walk(data)

  // 去重 key = game|icon|name
  const keyOf = (t) => `${game}|${t.icon || ''}|${t.name || ''}`
  const uniqueKeys = [...new Set(targets.map(keyOf))]
  const map = new Map()
  const concurrency = 8
  let i = 0
  async function worker() {
    while (i < uniqueKeys.length) {
      const idx = i++
      const key = uniqueKeys[idx]
      const parts = key.split('|')
      // game|icon|name  — icon/name 本身可能含 |，只拆前两段
      const g = parts[0]
      const rest = parts.slice(1)
      // 还原：最后一个是 name，中间合并为 icon
      const name = rest.length ? rest[rest.length - 1] : ''
      const icon = rest.length > 1 ? rest.slice(0, -1).join('|') : rest[0] || ''
      map.set(key, await iconToDataUri(icon, name, g))
    }
  }
  if (uniqueKeys.length) {
    await Promise.all(Array.from({ length: Math.min(concurrency, uniqueKeys.length) }, () => worker()))
  }

  for (const obj of targets) {
    obj.icon = map.get(keyOf(obj)) || ''
  }

  const ok = targets.filter((t) => String(t.icon).startsWith('data:image')).length
  if (typeof logger !== 'undefined') {
    logger.mark?.(`[xhh-TL][nanokaAbyss] 怪物图标 ${ok}/${targets.length} 已内嵌`)
  }
  return data
}

/** 兼容旧调用：仅返回主候选 URL（实际展示走 hydrate） */
function MONSTER_ICON(icon, game = 'gi') {
  const list = iconCandidates(icon, game)
  return list[0] || ''
}

const ELEM_CN = {
  0: '无',
  1: '物理',
  2: '火',
  3: '水',
  4: '草',
  5: '雷',
  6: '冰',
  7: '风',
  8: '岩',
  pyro: '火',
  hydro: '水',
  dendro: '草',
  electro: '雷',
  cryo: '冰',
  anemo: '风',
  geo: '岩',
  Physical: '物理',
  Fire: '火',
  Ice: '冰',
  Lightning: '雷',
  Thunder: '雷',
  Wind: '风',
  Quantum: '量子',
  Imaginary: '虚数',
}

const ELEM_CLASS = {
  2: 'pyro',
  3: 'hydro',
  4: 'dendro',
  5: 'electro',
  6: 'cryo',
  7: 'anemo',
  8: 'geo',
  Fire: 'pyro',
  Ice: 'cryo',
  Lightning: 'electro',
  Thunder: 'electro',
  Wind: 'anemo',
  Quantum: 'quantum',
  Imaginary: 'imaginary',
  Physical: 'physical',
  火: 'pyro',
  水: 'hydro',
  草: 'dendro',
  雷: 'electro',
  冰: 'cryo',
  风: 'anemo',
  岩: 'geo',
  量子: 'quantum',
  虚数: 'imaginary',
  物理: 'physical',
}

const pluginDir = path.join(process.cwd(), 'plugins/xhh-TL')

function cfg() {
  return readPluginConfig()
}

async function fetchJson(url, timeout = 10000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'xhh-TL/nanoka-abyss',
        Referer: 'https://nanoka.cc/',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function getManifest() {
  return fetchJson(MANIFEST_URL)
}

function stripColor(s = '') {
  return String(s)
    .replace(/<\/?color[^>]*>/gi, '')
    .replace(/<\/?unbreak>/gi, '')
    .replace(/#\d+\[i\]%?/g, (m) => m.replace(/[#\[\]i]/g, ''))
    .replace(/\\n/g, '\n')
    .trim()
}

function fmtRange(begin, end) {
  const b = begin ? moment(begin).format('MM-DD HH:mm') : '?'
  const e = end ? moment(end).format('MM-DD HH:mm') : '?'
  return `${b} ~ ${e}`
}

function pickLatestByEnd(mapObj) {
  const list = Object.entries(mapObj || {}).map(([id, v]) => ({
    id: String(id),
    ...v,
    _end: v.end || v.end_time || v.live_end || '',
    _begin: v.begin || v.begin_time || v.live_begin || '',
  }))
  list.sort((a, b) => String(a._end).localeCompare(String(b._end)))
  return list
}

function isPrevMsg(msg = '') {
  return /上期|上一期|上赛季|上一轮|previous|prev/i.test(msg)
}

/**
 * 数据通道：
 * - live   正式服（manifest.live，默认）
 * - latest 下期（manifest.latest）
 * 指令侧统一用「下期」，不再用「测试」作入口词
 */
function parseChannel(msg = '') {
  const s = String(msg)
  // 下期优先；显式「正式」可覆盖
  if (/正式|正式服|现网|live/i.test(s) && !/下期|beta|前瞻/i.test(s)) return 'live'
  if (/下期|beta|beta服|前瞻|前瞻服|最新包|latest/i.test(s)) return 'latest'
  // 旧习惯：#版本深渊测试 → 仍认，但不在文档/正则里推广
  if (/测试|测试服/i.test(s)) return 'latest'
  return 'live'
}

function channelLabel(channel) {
  return channel === 'latest' ? '下期' : '正式服'
}

function listOffset(msg = '') {
  if (isPrevMsg(msg)) return 1
  const m = String(msg).match(/(?:第)?(\d{1,3})期/)
  if (m) {
    // 第1期=基准 offset0，第2期=上期
    const n = Number(m[1])
    return Math.max(0, n - 1)
  }
  return 0
}

/**
 * 从按 end 升序的期数列表中选期
 * - preferActive：优先「当前时间正在进行」的一期（正式服默认）
 * - preferNewestIdWhenActive：有多期同时进行时，优先 id 更大的（beta 专属期，如 5269011 星芒之役）
 * - offset：相对基准往前推 N 期
 */
function resolvePeriod(list, offset = 0, { preferActive = false, preferNewestIdWhenActive = false } = {}) {
  if (!list.length) return null
  let baseIdx = list.length - 1
  if (preferActive) {
    const now = moment()
    const activeIdx = []
    for (let i = 0; i < list.length; i++) {
      const b = list[i]._begin
      const e = list[i]._end
      if (!b || !e) continue
      const begin = moment(b)
      const end = moment(e)
      if (begin.isValid() && end.isValid() && !begin.isAfter(now) && !end.isBefore(now)) {
        activeIdx.push(i)
      }
    }
    if (activeIdx.length === 1) {
      baseIdx = activeIdx[0]
    } else if (activeIdx.length > 1) {
      // 重叠期：取 id 最大（测试包新增期）或 end 最晚
      baseIdx = activeIdx.reduce((best, i) => {
        const a = list[i]
        const b = list[best]
        const idA = Number(a.id) || 0
        const idB = Number(b.id) || 0
        if (preferNewestIdWhenActive && idA !== idB) return idA > idB ? i : best
        return String(a._end).localeCompare(String(b._end)) >= 0 ? i : best
      }, activeIdx[0])
    }
  }
  const idx = Math.max(0, baseIdx - Math.max(0, offset))
  return {
    meta: list[idx],
    // 相对「基准期」的回看偏移，便于角标展示
    offset: baseIdx - idx,
    total: list.length,
    baseId: list[baseIdx].id,
  }
}

/**
 * 下期（latest）危战：优先选「相对正式服 live 多出来的 beta 期」
 * 例如 6.7.52 里 星芒之役 5269011 不在 6.7 正式列表中，而 栗烈 5269010 两边都有。
 * 若无 beta 专属期，再退回 end 最晚 / 进行中。
 */
async function resolveLeylinePeriod(version, channel, offset = 0) {
  const overall = await fetchJson(`${STATIC}/gi/${version}/leyline.json`)
  let list = pickLatestByEnd(overall)
  if (!list.length) throw new Error('幽境危战（leyline）数据为空')

  if (channel === 'latest') {
    // 尝试用 live 版本做差集，找出测试包新增期
    try {
      const manifest = await getManifest()
      const liveVer = pickGiVersion(manifest, 'live')
      if (liveVer && liveVer !== version) {
        const liveOverall = await fetchJson(`${STATIC}/gi/${liveVer}/leyline.json`)
        const liveIds = new Set(Object.keys(liveOverall || {}).map(String))
        const betaOnly = list.filter((x) => !liveIds.has(String(x.id)))
        if (betaOnly.length) {
          // beta 专属期：按 end 排序后取最新
          list = pickLatestByEnd(
            Object.fromEntries(betaOnly.map((x) => [x.id, x])),
          )
        }
      }
    } catch (_) {
      // 差集失败则走普通逻辑
    }
    // 下期：优先进行中的 beta 期（多期重叠取 id 更大），否则 end 最晚
    const picked = resolvePeriod(list, offset, {
      preferActive: true,
      preferNewestIdWhenActive: true,
    })
    return { list, picked, version }
  }

  // 正式：进行中（重叠时取 end 最晚，通常与正式节奏一致）
  const picked = resolvePeriod(list, offset, {
    preferActive: true,
    preferNewestIdWhenActive: false,
  })
  return { list, picked, version }
}

function pickGiVersion(manifest, channel = 'live') {
  const gi = manifest?.gi || {}
  if (channel === 'latest') {
    return gi.latest || gi.live || (gi.available || []).at(-1)
  }
  // 正式：live，若缺失再退 latest
  return gi.live || gi.latest || (gi.available || [])[0]
}

function pickHsrVersion(manifest, channel = 'live') {
  const hsr = manifest?.hsr || {}
  if (channel === 'latest') {
    return hsr.latest || hsr.live || (hsr.available || []).at(-1)
  }
  return hsr.live || hsr.latest || (hsr.available || [])[0]
}

// ---------------- Genshin ----------------

async function loadGiTower(offset = 0, channel = 'live') {
  const manifest = await getManifest()
  const version = pickGiVersion(manifest, channel)
  if (!version) throw new Error('Nanoka manifest 未返回原神版本')
  const overall = await fetchJson(`${STATIC}/gi/${version}/tower.json`)
  const list = pickLatestByEnd(overall)
  if (!list.length) throw new Error('深境螺旋数据为空')
  // 正式服：按真实时间取「进行中」；下期：取该包内 end 最晚的一期
  const picked = resolvePeriod(list, offset, { preferActive: channel === 'live' })
  const meta = picked.meta
  const detail = await fetchJson(`${STATIC}/gi/${version}/zh/tower/${meta.id}.json`)
  const floors = []
  const floorMap = detail.floor || {}
  for (const fid of Object.keys(floorMap).sort((a, b) => Number(a) - Number(b))) {
    const f = floorMap[fid]
    const rooms = []
    for (const rid of Object.keys(f.room || {}).sort((a, b) => Number(a) - Number(b))) {
      const room = f.room[rid]
      rooms.push({
        id: rid,
        level: room.level,
        first: (room.first || []).map((m) => ({
          id: m.id,
          name: m.name,
          hp: m.hp,
          hpText: formatHp(m.hp),
          icon: MONSTER_ICON(m.icon, 'gi'),
        })),
        second: (room.second || []).map((m) => ({
          id: m.id,
          name: m.name,
          hp: m.hp,
          hpText: formatHp(m.hp),
          icon: MONSTER_ICON(m.icon, 'gi'),
        })),
      })
    }
    floors.push({
      id: fid,
      floorLabel: `第 ${fid} 层`,
      // Nanoka 测试服会塞 (test) 血量行，正式展示过滤掉
      buff: (f.buff || [])
        .map(stripColor)
        .filter((b) => b && !/^\(test\)/i.test(String(b).trim())),
      rooms,
    })
  }
  const leyline = detail.leyline || {}
  const ch = channelLabel(channel)
  return {
    game: 'gi',
    gameName: 'GENSHIN IMPACT',
    mode: 'tower',
    modeName: '深境螺旋',
    version,
    channel,
    channelLabel: ch,
    periodId: meta.id,
    title: meta.zh || meta.en || leyline.name || `第 ${meta.id} 期`,
    timeRange: fmtRange(detail.open || meta._begin, detail.close || meta._end),
    buffTitle: leyline.name || meta.zh || '深渊祝福',
    buffDesc: stripColor(leyline.desc || meta.desc || ''),
    floors,
    offset: picked.offset,
    total: picked.total,
    source: 'Nanoka',
    note: '',
  }
}

async function loadGiRoleCombat(offset = 0, channel = 'live') {
  const manifest = await getManifest()
  const version = pickGiVersion(manifest, channel)
  if (!version) throw new Error('Nanoka manifest 未返回原神版本')
  const overall = await fetchJson(`${STATIC}/gi/${version}/rolecombat.json`)
  const list = pickLatestByEnd(overall)
  if (!list.length) throw new Error('幻想剧诗数据为空')
  const picked = resolvePeriod(list, offset, { preferActive: channel === 'live' })
  const meta = picked.meta
  const detail = await fetchJson(`${STATIC}/gi/${version}/zh/rolecombat/${meta.id}.json`)
  const cfg = detail.avatar_config || {}
  const elements = (cfg.element_list || meta.element || [])
    .map((e) => ELEM_CN[e] || String(e))
    .filter(Boolean)
  const invite = cfg.invite_avatar_list || meta.invite || []
  const buffAvatars = (cfg.buff_avatar_list || []).map((b) => ({
    id: b.id || b,
    desc: stripColor(b.desc || ''),
  }))

  // 关键关怪物：取最高难度
  const diff = detail.difficulty_config || {}
  const lastDiff = Object.values(diff).at(-1) || {}
  const stages = []
  const room = lastDiff.room || {}
  const hard = lastDiff.hard_room || {}
  for (const [rid, r] of Object.entries(room)) {
    if (!r?.monster_preview_list?.length && !r?.title) continue
    stages.push({
      tag: `第 ${rid} 幕`,
      title: r.title || '',
      desc: stripColor(r.desc || ''),
      level: r.monster_level,
      monsters: (r.monster_preview_list || []).map((m) => ({
        id: m.id,
        name: m.name,
        icon: MONSTER_ICON(m.icon, 'gi'),
      })),
    })
  }
  for (const [rid, r] of Object.entries(hard)) {
    stages.push({
      tag: `圣牌 ${rid}`,
      title: r.title || '',
      desc: stripColor(r.desc || ''),
      level: r.monster_level,
      monsters: (r.monster_preview_list || []).map((m) => ({
        id: m.id,
        name: m.name,
        icon: MONSTER_ICON(m.icon, 'gi'),
      })),
    })
  }

  return {
    game: 'gi',
    gameName: 'GENSHIN IMPACT',
    mode: 'rolecombat',
    modeName: '幻想真境剧诗',
    version,
    channel,
    channelLabel: channelLabel(channel),
    periodId: meta.id,
    title: `第 ${meta.id} 幕季`,
    timeRange: fmtRange(detail.begin_time || meta._begin, detail.end_time || meta._end),
    elements,
    inviteIds: invite,
    buffAvatars,
    stages,
    offset: picked.offset,
    total: picked.total,
    source: 'Nanoka',
    note: '',
  }
}

/**
 * 幽境危战 = Nanoka leyline（https://gi.nanoka.cc/leyline）
 * 展示「无畏 + 绝境」两档最高难度的 3 强敌 + 机制
 * （无畏 / 绝境 boss 名可能相同，但机制/词条往往不同，一并展示）
 *
 * 注意：测试包可能同时挂着「正式当期」和「beta 专属期」（时间重叠）。
 * #下期危战 通过 live/latest 差集优先取 beta 专属期（如 星芒之役 5269011）。
 */
async function loadGiLeyline(offset = 0, channel = 'live') {
  const manifest = await getManifest()
  const version = pickGiVersion(manifest, channel)
  if (!version) throw new Error('Nanoka manifest 未返回原神版本')
  const { picked } = await resolveLeylinePeriod(version, channel, offset)
  const meta = picked.meta
  const detail = await fetchJson(`${STATIC}/gi/${version}/zh/leyline/${meta.id}.json`)

  // level map: 按 difficulty_config.level 排序
  const levels = Object.entries(detail.level || {}).map(([id, lv]) => {
    const dc = lv.difficulty_config || {}
    // level_config 的 key 顺序不保证，按 key 排序保证阶段 1/2/3 稳定
    const bossEntries = Object.entries(lv.level_config || {}).sort((a, b) =>
      String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }),
    )
    return {
      id,
      // Nanoka 的 monster_level 比游戏内展示低 1（无畏 104→105，绝境 109→110）
      monsterLevelRaw: Number(lv.monster_level) || 0,
      monsterLevel: (Number(lv.monster_level) || 0) + 1,
      diffLevel: Number(dc.level) || 0,
      diffName: dc.name || `难度${id}`,
      rules: (dc.desc_list || []).map(stripColor).filter(Boolean),
      bosses: bossEntries.map(([bid, b]) => ({
        id: bid,
        name: b.name || String(bid),
        icon: MONSTER_ICON(b.icon, 'gi'),
        desc: stripColor(b.desc || ''),
        buffs: (b.monster_buff_name_list || []).map((n, i) => ({
          name: stripColor(n),
          desc: stripColor((b.monster_buff_desc_list || [])[i] || ''),
        })),
      })),
    }
  })
  levels.sort((a, b) => a.diffLevel - b.diffLevel)
  if (!levels.length) throw new Error('幽境危战难度数据为空')

  // 取最高两档：绝境(6) + 无畏(5)；不足两档则全取
  // 也兼容按名称匹配，防止 difficulty level 编号变化
  const byName = (re) => levels.filter((l) => re.test(String(l.diffName || '')))
  let showLevels = []
  const fearless = byName(/无畏/)
  const dire = byName(/绝境/)
  if (fearless.length || dire.length) {
    // 保持从低到高：无畏 → 绝境
    showLevels = [...fearless, ...dire]
    // 去重（同名多档时）
    const seen = new Set()
    showLevels = showLevels.filter((l) => {
      const k = `${l.diffLevel}|${l.diffName}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }
  if (!showLevels.length) {
    showLevels = levels.slice(-2)
  }

  // 两列布局数据：左无畏 / 右绝境（每列 3 个 boss 自上而下）
  const diffColumns = showLevels.map((diff) => {
    const name = String(diff.diffName || '')
    let colClass = ''
    if (/绝境/.test(name)) colClass = 'dire'
    else if (/无畏/.test(name)) colClass = 'fearless'
    return {
      diffName: diff.diffName,
      diffLevel: diff.diffLevel,
      monsterLevel: diff.monsterLevel,
      colClass,
      rules: diff.rules || [],
      bosses: (diff.bosses || []).map((b, i) => {
        const buffText = (b.buffs || [])
          .map((x) => (x.desc ? `【${x.name}】${x.desc}` : x.name))
          .filter(Boolean)
          .join('\n')
        return {
          id: b.id,
          name: b.name,
          icon: b.icon,
          phase: i + 1,
          desc:
            buffText ||
            (b.desc && b.desc.length > 220 ? `${b.desc.slice(0, 220)}…` : b.desc) ||
            '',
        }
      }),
    }
  })

  // 顶部规则：两档都写
  const ruleBlocks = showLevels
    .map((d) => {
      const body = (d.rules || []).join('；')
      return body ? `【${d.diffName}】${body}` : `【${d.diffName}】敌人 Lv.${d.monsterLevel}`
    })
    .filter(Boolean)
  const ch = channelLabel(channel)
  const diffLabel = showLevels.map((d) => d.diffName).join(' + ')
  return {
    game: 'gi',
    gameName: 'GENSHIN IMPACT',
    mode: 'leyline',
    modeName: '幽境危战',
    version,
    channel,
    channelLabel: ch,
    periodId: meta.id,
    title: detail.name || meta.zh || meta.en || meta.id,
    timeRange: fmtRange(detail.begin_time || meta._begin, detail.end_time || meta._end),
    buffTitle: `${diffLabel} · 敌人 Lv.${showLevels.map((d) => d.monsterLevel).join('/')}`,
    buffDesc: ruleBlocks.join('\n'),
    // 两列：无畏 | 绝境
    diffColumns,
    stages: null,
    leylineDiffs: levels.map((l) => `${l.diffName}(Lv.${l.monsterLevel})`),
    offset: picked.offset,
    total: picked.total,
    source: 'Nanoka',
    note: '',
  }
}

// ---------------- Star Rail ----------------

/**
 * 星铁 endgame 数据源（Nanoka）：
 * - maze       → 混沌回忆   *版本混沌 / *下期混沌
 * - maze_extra → 虚构叙事   *版本虚构 / *下期虚构   详情 zh/story/{id}.json
 * - maze_boss  → 末日幻影   *版本末日 / *下期末日   详情 zh/boss/{id}.json
 * - maze_peak  → 异相仲裁   *版本异相 / *下期异相   详情 zh/peak/{id}.json
 *
 * 期数选取（用户约定）：
 * - 最大 id = 下期
 * - 第二大 id = 正式/版本当期
 */
const HSR_MODES = {
  chaos: {
    key: 'chaos',
    modeName: '星铁·混沌回忆',
    overview: 'maze.json',
    detail: (ver, id) => `${STATIC}/hsr/${ver}/zh/maze/${id}.json`,
    // maze 里 1000+ 才是混沌挑战线
    filterIds: (id) => Number(id) >= 1000,
  },
  story: {
    key: 'story',
    modeName: '星铁·虚构叙事',
    overview: 'maze_extra.json',
    detail: (ver, id) => `${STATIC}/hsr/${ver}/zh/story/${id}.json`,
    filterIds: () => true,
  },
  boss: {
    key: 'boss',
    modeName: '星铁·末日幻影',
    overview: 'maze_boss.json',
    detail: (ver, id) => `${STATIC}/hsr/${ver}/zh/boss/${id}.json`,
    filterIds: () => true,
  },
  peak: {
    key: 'peak',
    modeName: '星铁·异相仲裁',
    overview: 'maze_peak.json',
    detail: (ver, id) => `${STATIC}/hsr/${ver}/zh/peak/${id}.json`,
    filterIds: () => true,
  },
  memory: {
    key: 'memory',
    modeName: '星铁·记忆紊流',
    overview: 'maze.json',
    detail: (ver, id) => `${STATIC}/hsr/${ver}/zh/maze/${id}.json`,
    filterIds: (id) => {
      const n = Number(id)
      return n >= 100 && n < 200
    },
  },
}

function classifyHsrMazeId(id) {
  const n = Number(id)
  if (n >= 1000) return { key: 'challenge', name: '挑战线' }
  if (n === 900 || (n >= 900 && n < 1000)) return { key: 'special', name: '特殊' }
  if (n >= 100 && n < 200) return { key: 'memory', name: '记忆紊流' }
  return { key: 'legacy', name: '回忆' }
}

/** 从节点名解析层号：学院怪谈其九 → 9；构事生意其三 → 3 */
function parseHsrFloorNo(name = '', index = 0) {
  const s = String(name || '')
  const cnMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  const m12 = s.match(/其十([一二])/)
  if (m12) return 10 + (m12[1] === '一' ? 1 : 2)
  if (/其十(?![一二])/.test(s)) return 10
  const m = s.match(/其([一二三四五六七八九])/)
  if (m) return cnMap[m[1]] || 0
  const p = s.match(/（([一二三四五六七八九])）/)
  if (p) return cnMap[p[1]] || 0
  const n = s.match(/(?:第)?(\d{1,2})\s*(?:层|节点)?/)
  if (n) return Number(n[1])
  return index + 1
}

/**
 * 最大 id = 下期；第二大 = 正式；再叠加上期 offset
 */
function pickHsrByRank(list, offset = 0, channel = 'live') {
  if (!list.length) return null
  const baseFromEnd = channel === 'latest' ? 0 : Math.min(1, list.length - 1)
  const fromEnd = baseFromEnd + Math.max(0, offset)
  const idx = Math.max(0, list.length - 1 - fromEnd)
  return {
    meta: list[idx],
    offset: fromEnd,
    total: list.length,
    baseId: list[Math.max(0, list.length - 1 - baseFromEnd)].id,
  }
}

/** HSR 怪物 id 常带难度后缀：302401304 → 3024013 → 3024010 */
function resolveHsrMonster(id, monDb = {}) {
  const s = String(id)
  const tryIds = [s]
  if (s.length >= 7) tryIds.push(s.slice(0, 7))
  if (s.length >= 6) tryIds.push(s.slice(0, 6))
  // 末位递减试探
  if (/^\d+$/.test(s) && s.length >= 7) {
    const head = s.slice(0, -2)
    for (let i = 0; i <= 9; i++) tryIds.push(head + i)
  }
  for (const k of tryIds) {
    const m = monDb[k] || monDb[Number(k)]
    if (m && (m.zh || m.en || m.icon)) return m
  }
  // 前缀模糊
  for (const len of [7, 6]) {
    const p = s.slice(0, len)
    for (const [k, v] of Object.entries(monDb)) {
      if (String(k).startsWith(p) && (v.zh || v.en)) return v
    }
  }
  return {}
}

/** 血量展示：统一带 HP 前缀；>=1万用「x.x万」，否则整数 */
function formatHp(hp) {
  const n = Number(hp)
  if (!Number.isFinite(n) || n <= 0) return ''
  let body = ''
  if (n >= 100000000) body = `${(n / 100000000).toFixed(2)}亿`
  else if (n >= 10000) {
    const w = n / 10000
    body = `${w >= 100 ? w.toFixed(0) : w.toFixed(1)}万`
  } else body = `${Math.round(n)}`
  return `HP ${body}`
}

/** 加载 HSR 血量计算表（缓存） */
let _hsrStatCache = null
async function loadHsrStatTables(version) {
  if (_hsrStatCache?.version === version) return _hsrStatCache
  const [mv, hl, eg, ieg] = await Promise.all([
    fetchJson(`${STATIC}/hsr/${version}/monstervalue.json`).catch(() => ({})),
    fetchJson(`${STATIC}/hsr/${version}/HardLevelGroup.json`).catch(() => []),
    fetchJson(`${STATIC}/hsr/${version}/EliteGroup.json`).catch(() => []),
    fetchJson(`${STATIC}/hsr/${version}/InfiniteEliteGroup.json`).catch(() => []),
  ])
  const hlMap = new Map()
  for (const x of Array.isArray(hl) ? hl : []) {
    hlMap.set(`${x.HardLevelGroup}|${x.Level}`, x)
  }
  const egMap = new Map()
  for (const x of Array.isArray(eg) ? eg : []) {
    egMap.set(Number(x.EliteGroup), x)
  }
  // 异相 infinite 波次精英倍率
  const iegMap = new Map()
  for (const x of Array.isArray(ieg) ? ieg : []) {
    iegMap.set(Number(x.EliteGroup), x)
  }
  _hsrStatCache = { version, mv: mv || {}, hlMap, egMap, iegMap }
  return _hsrStatCache
}

/**
 * 估算 HSR 怪物血量（对齐 nanoka EndgameEnemyWaveBoard）：
 * HPBase * child.HPModifyRatio * HardLevel.HPRatio * Elite.HPRatio
 * 优先用 event/infinite 波次里的精确 monsterId 匹配 child.Id
 * 返回 { hp, phases: number[], total }
 */
function resolveHsrValueEntry(monsterId, tables) {
  if (!tables || !monsterId) return { val: null, child: null, baseId: String(monsterId) }
  const { mv } = tables
  const s = String(monsterId)
  let val = mv[s] || mv[Number(s)]
  if (val) {
    const child =
      (val.child || []).find((c) => String(c.Id) === s) || (val.child || [])[0] || null
    return { val, child, baseId: s }
  }
  for (const [k, v] of Object.entries(mv)) {
    const hit = (v.child || []).find((c) => String(c.Id) === s)
    if (hit) return { val: v, child: hit, baseId: String(k) }
  }
  for (const len of [7, 6]) {
    const p = s.slice(0, len)
    if (mv[p] || mv[Number(p)]) {
      val = mv[p] || mv[Number(p)]
      const child =
        (val.child || []).find((c) => String(c.Id) === s) ||
        (val.child || []).find((c) => String(c.Id).startsWith(p)) ||
        (val.child || [])[0] ||
        null
      return { val, child, baseId: p }
    }
  }
  return { val: null, child: null, baseId: s }
}

function calcHsrHpDetail(monsterId, hardLevelGroup, level, eliteGroup, tables, { infinite = false } = {}) {
  if (!tables || !monsterId) return { hp: 0, phases: [], total: 0 }
  const { hlMap, egMap, iegMap } = tables
  const { val, child } = resolveHsrValueEntry(monsterId, tables)
  if (!val || !child) return { hp: 0, phases: [], total: 0 }
  const base = Number(val.HPBase) || 0
  const hpMod = Number(child.HPModifyRatio) || 1
  const hlg = Number(hardLevelGroup) || Number(child.HardLevelGroup) || 1
  const lv = Number(level) || 80
  const hl = hlMap.get(`${hlg}|${lv}`) || hlMap.get(`${child.HardLevelGroup || 1}|${lv}`)
  const hlHp = Number(hl?.HPRatio) || 1
  const egId = Number(eliteGroup) || Number(child.EliteGroup) || 1
  // 异相 infinite 波次：先查 InfiniteEliteGroup，再 EliteGroup
  let eg = null
  if (infinite) {
    eg = iegMap?.get(egId) || egMap.get(egId)
  } else {
    eg = egMap.get(egId) || iegMap?.get(egId)
  }
  if (!eg) eg = egMap.get(Number(child.EliteGroup)) || { HPRatio: 1 }
  const egHp = Number(eg.HPRatio) || 1
  const single = base * hpMod * hlHp * egHp
  const phaseList = Array.isArray(val.PhaseList) ? val.PhaseList : []
  const maxPhase = Number(val.MaxMonsterPhase) || phaseList.length || 1
  const phases = []
  if (maxPhase > 1) {
    for (let i = 0; i < maxPhase; i++) {
      const ratio = Number(phaseList[i]?.phase_max_hp_ratio ?? phaseList[i]?.PhaseMaxHPRatio) || 1
      phases.push(single * ratio)
    }
  }
  const total = phases.length ? phases.reduce((a, b) => a + b, 0) : single
  return { hp: single, phases, total }
}

function calcHsrHp(monsterId, hardLevelGroup, level, eliteGroup, tables, opts = {}) {
  return calcHsrHpDetail(monsterId, hardLevelGroup, level, eliteGroup, tables, opts).hp
}

function formatPhaseHpText(detail) {
  if (!detail || !detail.hp) return ''
  if (detail.phases?.length > 1) {
    // 多阶段：HP P1 xx / P2 xx（与 nanoka 网页一致，统一带 HP）
    const body = detail.phases
      .map((p) => {
        // formatHp 已带 HP 前缀，阶段展示取数值部分
        const t = formatHp(p).replace(/^HP\s*/, '')
        return t
      })
      .map((t, i) => `P${i + 1} ${t}`)
      .join(' / ')
    return `HP ${body}`
  }
  return formatHp(detail.hp)
}

function makeHsrMonResolver(monDb, tables = null) {
  return (id, battleCtx = null) => {
    const m = resolveHsrMonster(id, monDb)
    const { baseId, child } = resolveHsrValueEntry(id, tables || { mv: {} })
    const baseMon = resolveHsrMonster(baseId, monDb)
    let hp = 0
    let hpText = ''
    if (tables && battleCtx) {
      const detail = calcHsrHpDetail(
        id,
        battleCtx.hardLevelGroup,
        battleCtx.level,
        battleCtx.eliteGroup,
        tables,
        { infinite: !!battleCtx.infinite },
      )
      hp = detail.total || detail.hp
      hpText = formatPhaseHpText(detail)
    }
    let weak = (m.weak || baseMon.weak || []).map((w) => ELEM_CN[w] || w)
    if (child?.StanceWeakList?.length) {
      weak = child.StanceWeakList.map((w) => ELEM_CN[w] || w)
    }
    return {
      id,
      name: m.zh || m.en || baseMon.zh || baseMon.en || String(id),
      icon: MONSTER_ICON(m.icon || baseMon.icon, 'hsr'),
      weak,
      hp,
      hpText,
    }
  }
}

/** 从 event 列表提取战斗上下文（level / hard / elite） */
function battleCtxFromEvents(events) {
  const ev = (events || [])[0]
  if (!ev) return null
  return {
    hardLevelGroup: Number(ev.hard_level_group) || 1,
    level: Number(ev.level) || 80,
    eliteGroup: Number(ev.elite_group) || 0,
    infinite: false,
  }
}

/**
 * 从 event.monster_list 按波次抽出怪物（保留两波）
 */
function monstersFromEventWaves(events, resolveMon, tables = null) {
  const ctx = battleCtxFromEvents(events)
  const resolve = (id) => resolveMon(id, ctx)
  const waves = []
  for (const ev of events || []) {
    for (const wave of ev.monster_list || []) {
      const keys = Object.keys(wave || {}).filter((k) => k.startsWith('monster') && wave[k])
      keys.sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')))
      const ids = keys.map((k) => wave[k])
      if (ids.length) waves.push(ids.map(resolve))
    }
  }
  return { waves, flat: waves.flat(), ctx }
}

/**
 * 从 peak/infinite_list 按波次抽怪（每波自带 elite_group）
 * infinite_list: { id: { monster_group_id_list, elite_group, ... }, ... }
 */
function monstersFromInfiniteList(infiniteList, baseCtx, resolveMon, tables = null) {
  const waves = []
  const entries = Object.entries(infiniteList || {}).sort((a, b) =>
    String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }),
  )
  for (const [, wave] of entries) {
    if (!wave) continue
    const ids = wave.monster_group_id_list || wave.monster_list || []
    const list = Array.isArray(ids) ? ids : []
    if (!list.length) continue
    const ctx = {
      hardLevelGroup: baseCtx?.hardLevelGroup || 3,
      level: baseCtx?.level || 95,
      eliteGroup: Number(wave.elite_group) || baseCtx?.eliteGroup || 0,
      infinite: true,
    }
    waves.push(list.map((id) => resolveMon(id, ctx)))
  }
  return { waves, flat: waves.flat() }
}

function fillMonFromEvents(events, fallback, resolveMon, tables = null) {
  const { flat, waves } = monstersFromEventWaves(events, resolveMon, tables)
  if (flat.length) {
    return flat.map((m, idx) => {
      let waveNo = 1
      let seen = 0
      for (let w = 0; w < waves.length; w++) {
        if (seen + waves[w].length > idx) {
          waveNo = w + 1
          break
        }
        seen += waves[w].length
      }
      return { ...m, wave: waveNo }
    })
  }
  const ctx = battleCtxFromEvents(events)
  return (fallback || []).map((m) => {
    if (!tables || !ctx) return { ...m, wave: 1 }
    const detail = calcHsrHpDetail(m.id, ctx.hardLevelGroup, ctx.level, ctx.eliteGroup, tables)
    return {
      ...m,
      hp: detail.total || detail.hp,
      hpText: formatPhaseHpText(detail),
      wave: 1,
    }
  })
}

function mapHsrTypes(arr) {
  return (arr || []).map((t) => ({ name: ELEM_CN[t] || t, cls: ELEM_CLASS[t] || '' }))
}

/** 格式化挑战目标：替换 #1[i] 为 param */
function formatHsrChallenges(list = [], { onlyFirst = false } = {}) {
  const arr = (list || [])
    .map((c) => {
      let name = stripColor(c.name || '')
      if (c.param != null && c.param !== '') {
        const p = String(c.param)
        name = name
          .replace(/#\d+\[i\]%?/gi, p)
          .replace(/#\d+/g, p)
          .replace(/<\/?unbreak>/gi, '')
      }
      return name.trim()
    })
    .filter(Boolean)
  return onlyFirst ? arr.slice(0, 1) : arr.slice(0, 3)
}

/**
 * 混沌 maze：9–12 层，星启并入第 12 层
 * - 普通层 20 回合；星启 30 回合（游戏内口径）
 * - 第12层三列：节点一 + 节点二 + 星启
 */
function floorsFromMazeNodes(nodes, meta, resolveMon, tables = null) {
  const list = Array.isArray(nodes) ? nodes : []
  const dual = []
  const finales = []
  list.forEach((n, i) => {
    if (!n) return
    if ((n.npc_monster_id_list && !n.npc_monster_id_list1) || (n.pre_id && !n.name)) {
      finales.push({ n, i })
      return
    }
    if (n.npc_monster_id_list1 || n.name) dual.push({ n, i })
  })

  const byNo = new Map()
  dual.forEach((item) => {
    byNo.set(parseHsrFloorNo(item.n.name, item.i), item)
  })

  const floor12 = byNo.get(12) || dual[dual.length - 1] || null
  let star = null
  if (floor12) {
    const preId = floor12.n.id
    star =
      finales.find((f) => String(f.n.pre_id) === String(preId)) || finales[finales.length - 1] || null
  } else {
    star = finales[finales.length - 1] || null
  }

  const floors = []
  const pushDualFloor = (item, floorNo, withStar = null) => {
    if (!item) return
    const n = item.n
    const leftRaw = (n.npc_monster_id_list1 || []).map(resolveMon)
    const rightRaw = (n.npc_monster_id_list2 || []).map(resolveMon)
    const left = fillMonFromEvents(n.event_id_list1, leftRaw, resolveMon, tables)
    const right = fillMonFromEvents(n.event_id_list2, rightRaw, resolveMon, tables)
    let starMons = []
    let typeStar = []
    let starDesc = ''
    if (withStar) {
      const sn = withStar.n
      const starRaw = (sn.npc_monster_id_list || []).map(resolveMon)
      const fromEvent = fillMonFromEvents(sn.event_id_list, starRaw, resolveMon, tables)
      starMons = fromEvent.length ? fromEvent : starRaw
      typeStar = mapHsrTypes(sn.damage_type || sn.damage_type1)
      const special = sn.challenge_special
        ? stripColor(
            String(sn.challenge_special.name || '')
              .replace(/#\d+\[i\]%?/gi, String(sn.challenge_special.param ?? ''))
              .replace(/#\d+/g, String(sn.challenge_special.param ?? '')),
          ) + (sn.challenge_special.param != null ? `（${sn.challenge_special.param}）` : '')
        : ''
      starDesc = special ? `星启特殊目标：${special}` : '星启模式 · 30 回合'
    }
    floors.push({
      index: floors.length + 1,
      floorNo,
      floorLabel: withStar ? `第 ${floorNo} 层（含星启）` : n.name || `第 ${floorNo} 层`,
      name: n.name || `第 ${floorNo} 层`,
      group: n.group_name || meta.zh || meta.en,
      desc: [stripColor(n.desc || ''), starDesc].filter(Boolean).join('\n'),
      // 游戏内：普通 20 回合，星启 30 回合
      countdown: 20,
      starCountdown: withStar ? 30 : undefined,
      challenges: formatHsrChallenges(n.challenge),
      type1: mapHsrTypes(n.damage_type1),
      type2: mapHsrTypes(n.damage_type2),
      typeStar,
      left,
      right,
      star: starMons,
      hasSides: true,
      hasStar: starMons.length > 0,
      hasTypes: true,
    })
  }

  // 高→低：12(+星启) → 11 → 10 → 9
  pushDualFloor(byNo.get(12) || floor12, 12, star)
  for (const no of [11, 10, 9]) pushDualFloor(byNo.get(no), no, null)
  return floors
}

/** 虚构 story：只渲染阶段 3 + 阶段 4
 * - 阶段3：双节点（其三）
 * - 阶段4：双节点（其四）+ 星启模式（第三节点，pre_id→其四）
 * 展示顺序：阶段4 → 阶段3（高→低）
 */
function floorsFromStoryDetail(detail, resolveMon, tables = null) {
  const levels = Array.isArray(detail.level) ? detail.level : []
  const dual = []
  const finales = []
  levels.forEach((n, i) => {
    if (!n) return
    if (n.npc_monster_id_list && !n.npc_monster_id_list1) {
      finales.push({ n, i })
      return
    }
    if (n.npc_monster_id_list1 || n.name) dual.push({ n, i })
  })

  const stage3 = dual[2] || null
  const stage4Dual = dual[3] || null
  let stage4Star = null
  if (stage4Dual) {
    const preId = stage4Dual.n.id
    stage4Star =
      finales.find((f) => String(f.n.pre_id) === String(preId)) || finales[finales.length - 1] || null
  } else {
    stage4Star = finales[finales.length - 1] || null
  }

  const floors = []

  const buildStarSide = (item) => {
    if (!item) return []
    const n = item.n
    const raw = (n.npc_monster_id_list || []).map(resolveMon)
    return fillMonFromEvents(n.event_id_list, raw, resolveMon, tables)
  }

  const pushStage = (dualItem, starItem, stageTag, floorNo) => {
    if (!dualItem && !starItem) return
    const n = dualItem?.n || {}
    const leftRaw = (n.npc_monster_id_list1 || []).map(resolveMon)
    const rightRaw = (n.npc_monster_id_list2 || []).map(resolveMon)
    const left = dualItem ? fillMonFromEvents(n.event_id_list1, leftRaw, resolveMon, tables) : []
    const right = dualItem ? fillMonFromEvents(n.event_id_list2, rightRaw, resolveMon, tables) : []
    const star = buildStarSide(starItem)
    const starN = starItem?.n

    floors.push({
      index: floors.length + 1,
      floorNo,
      stage: stageTag,
      floorLabel: star.length ? `${stageTag}（含星启）` : stageTag,
      name: n.name || stageTag,
      group: detail.name,
      desc: '',
      countdown: undefined,
      challenges: [],
      type1: mapHsrTypes(n.damage_type1),
      type2: mapHsrTypes(n.damage_type2),
      typeStar: mapHsrTypes(starN?.damage_type || starN?.damage_type1),
      left,
      right,
      star,
      hasSides: true,
      hasStar: star.length > 0,
      hasTypes: true,
    })
  }

  // 高→低：阶段4（双+星启）→ 阶段3（双）
  pushStage(stage4Dual, stage4Star, '阶段4', 40)
  pushStage(stage3, null, '阶段3', 30)

  return floors
}

/** 末日 boss：同虚构
 * - 阶段3 = 难度03 双节点
 * - 阶段4 = 难度04 双节点 + 星启终局（pre_id→难度04）
 */
function floorsFromBossDetail(detail, resolveMon, tables = null) {
  const levels = Array.isArray(detail.level) ? detail.level : []
  const dual = levels.filter((n) => n && (n.boss_monster_id1 || n.npc_monster_id_list1))
  const finales = levels.filter((n) => n && n.boss_monster_id && !n.boss_monster_id1)

  // dual 按 difficulty 升序：0=难度1 … 3=难度4
  dual.sort((a, b) => {
    const da = a.boss_monster_config1?.difficulty || a.boss_monster_config2?.difficulty || 0
    const db = b.boss_monster_config1?.difficulty || b.boss_monster_config2?.difficulty || 0
    return Number(da) - Number(db)
  })

  const stage3 = dual[2] || null // 难度03
  const stage4Dual = dual[3] || dual[dual.length - 1] || null // 难度04
  let stage4Star = null
  if (stage4Dual) {
    const preId = stage4Dual.id
    stage4Star =
      finales.find((f) => String(f.pre_id) === String(preId)) || finales[finales.length - 1] || null
  } else {
    stage4Star = finales[finales.length - 1] || null
  }

  const floors = []

  const pushStage = (dualN, starN, stageTag, floorNo) => {
    if (!dualN && !starN) return
    const n = dualN || {}
    const leftId = n.boss_monster_id1 || (n.npc_monster_id_list1 || [])[0]
    const rightId = n.boss_monster_id2 || (n.npc_monster_id_list2 || [])[0]
    const leftRaw = leftId ? [resolveMon(leftId)] : []
    const rightRaw = rightId ? [resolveMon(rightId)] : []
    const left = dualN ? fillMonFromEvents(n.event_id_list1, leftRaw, resolveMon, tables) : []
    const right = dualN ? fillMonFromEvents(n.event_id_list2, rightRaw, resolveMon, tables) : []

    let star = []
    if (starN) {
      const monId = starN.boss_monster_id
      const starRaw = monId ? [resolveMon(monId)] : []
      star = fillMonFromEvents(starN.event_id_list, starRaw, resolveMon, tables)
    }

    const tags = [
      ...((n.boss_monster_config1 || {}).tag_list || []),
      ...((n.boss_monster_config2 || {}).tag_list || []),
      ...((starN?.boss_monster_config || {}).tag_list || []),
    ]
      .map((t) => stripColor(t.name || ''))
      .filter(Boolean)

    const diff =
      n.boss_monster_config1?.difficulty ||
      n.boss_monster_config2?.difficulty ||
      ''
    const titleBase = n.name
      ? stripColor(String(n.name).replace(/<\/?unbreak>/gi, ''))
      : diff
        ? `难度 ${diff}`
        : stageTag

    floors.push({
      index: floors.length + 1,
      floorNo,
      stage: stageTag,
      floorLabel: star.length ? `${stageTag}（含星启）` : stageTag,
      name: titleBase,
      group: detail.name,
      desc: tags.length ? `机制：${[...new Set(tags)].join(' / ')}` : '',
      challenges: [],
      type1: mapHsrTypes(n.damage_type1),
      type2: mapHsrTypes(n.damage_type2),
      typeStar: mapHsrTypes(starN?.damage_type || starN?.damage_type1),
      left: dualN ? left : [],
      right: dualN ? right : [],
      star,
      hasSides: true,
      hasStar: star.length > 0,
      hasTypes: true,
    })
  }

  // 高→低：阶段4（双+星启）→ 阶段3
  pushStage(stage4Dual, stage4Star, '阶段4', 40)
  pushStage(stage3, null, '阶段3', 30)

  return floors
}

/** 异相 peak：绝境 boss → 主 boss → 预选关 高到低
 * 怪物与血量优先走 infinite_list（每波自带 elite_group），否则 event.monster_list
 */
function floorsFromPeakDetail(detail, resolveMon, tables = null) {
  const floors = []
  const pushStage = (n, floorNo, label) => {
    if (!n) return
    const types = n.damage_type || n.damage_type1 || []
    const tags = (n.tag_list || []).map((t) => stripColor(t.name || '')).filter(Boolean)
    // 基础等级/难度来自 event
    const baseCtx = battleCtxFromEvents(n.event_id_list) || {
      hardLevelGroup: 3,
      level: 95,
      eliteGroup: 0,
    }
    let mons = []
    if (n.infinite_list && Object.keys(n.infinite_list).length) {
      const { flat, waves } = monstersFromInfiniteList(
        n.infinite_list,
        baseCtx,
        resolveMon,
        tables,
      )
      mons = flat.map((m, idx) => {
        let waveNo = 1
        let seen = 0
        for (let w = 0; w < waves.length; w++) {
          if (seen + waves[w].length > idx) {
            waveNo = w + 1
            break
          }
          seen += waves[w].length
        }
        return { ...m, wave: waveNo }
      })
    } else {
      mons = fillMonFromEvents(n.event_id_list, [], resolveMon, tables)
    }
    floors.push({
      index: floors.length + 1,
      floorNo,
      floorLabel: label || n.name || n.hard_name || `节点`,
      name: label || n.name || n.hard_name || `节点`,
      group: detail.name,
      desc: tags.length ? `机制：${tags.join(' / ')}` : '',
      type1: mapHsrTypes(types),
      type2: [],
      left: mons,
      right: [],
      hasSides: mons.length > 0,
      hasTypes: types.length > 0,
    })
  }

  // 绝境
  if (detail.boss_config) {
    const hardName = detail.boss_config.hard_name || '绝境'
    // 绝境等级以 event 为准（通常 120）
    pushStage(detail.boss_config, 300, hardName)
  }
  // 主 boss
  if (detail.boss_level) {
    pushStage(detail.boss_level, 200, detail.boss_level.name || '首领')
  }
  // 预选 3→1
  const pre = Array.isArray(detail.pre_level) ? detail.pre_level : []
  pre
    .slice()
    .reverse()
    .forEach((n, i) => {
      pushStage(n, 100 - i, n.name || `预选 ${pre.length - i}`)
    })
  return floors
}

function sortFloorsHighToLow(floors, modeKey) {
  let list = floors.slice()
  // 混沌/虚构/末日已在各自 builder 排好序并含星启，保持原序
  if (modeKey === 'chaos' || modeKey === 'memory' || modeKey === 'story' || modeKey === 'boss') {
    return list
  }
  return list.sort((a, b) => (b.floorNo || b.index || 0) - (a.floorNo || a.index || 0))
}

async function loadHsrEndgame(modeKey = 'chaos', offset = 0, channel = 'live') {
  const mode = HSR_MODES[modeKey] || HSR_MODES.chaos
  const manifest = await getManifest()
  const version = pickHsrVersion(manifest, channel)
  if (!version) throw new Error('Nanoka manifest 未返回星铁版本')

  const overall = await fetchJson(`${STATIC}/hsr/${version}/${mode.overview}`)
  let list = Object.entries(overall || {})
    .filter(([id]) => mode.filterIds(id))
    .map(([id, v]) => ({
      id: String(id),
      ...v,
      zh: v.zh || v.en || String(id),
      en: v.en || '',
    }))
  list.sort((a, b) => Number(a.id) - Number(b.id))
  if (!list.length) throw new Error(`${mode.modeName} 数据为空`)

  const picked = pickHsrByRank(list, offset, channel)
  const meta = picked.meta
  const detail = await fetchJson(mode.detail(version, meta.id))
  const monDb = await fetchJson(`${STATIC}/hsr/${version}/monster.json`).catch(() => ({}))
  const tables = await loadHsrStatTables(version)
  const resolveMon = makeHsrMonResolver(monDb, tables)

  let floors = []
  let buffTitle = meta.zh || meta.en || meta.id
  let buffDesc = ''

  if (modeKey === 'chaos' || modeKey === 'memory') {
    floors = floorsFromMazeNodes(detail, meta, resolveMon, tables)
    buffTitle = floors[0]?.group || buffTitle
    buffDesc = floors[0]?.desc || ''
  } else if (modeKey === 'story') {
    floors = floorsFromStoryDetail(detail, resolveMon, tables)
    buffTitle = detail.name || buffTitle
    const opts = [...(detail.option || []), ...(detail.sub_option || [])]
      .map((o) => stripColor(o.name || ''))
      .filter(Boolean)
    buffDesc = opts.length
      ? `周期选项：${opts.join(' / ')}`
      : stripColor(detail.buff?.desc || '')
  } else if (modeKey === 'boss') {
    floors = floorsFromBossDetail(detail, resolveMon, tables)
    buffTitle = detail.name || buffTitle
    buffDesc = stripColor(detail.buff?.desc || detail.buff?.name || '')
  } else if (modeKey === 'peak') {
    floors = floorsFromPeakDetail(detail, resolveMon, tables)
    buffTitle = detail.name || buffTitle
    buffDesc = ''
  }

  floors = sortFloorsHighToLow(floors, modeKey)

  return {
    game: 'hsr',
    gameName: 'HONKAI STAR RAIL',
    mode: modeKey,
    modeName: mode.modeName,
    version,
    channel,
    channelLabel: channelLabel(channel),
    periodId: meta.id,
    title: detail.name || meta.zh || meta.en || meta.id,
    timeRange: fmtRange(detail.begin_time || meta.begin || meta.live_begin, detail.end_time || meta.end || meta.live_end),
    buffTitle,
    buffDesc,
    floors,
    offset: picked.offset,
    total: list.length,
    source: 'Nanoka',
    note: '',
  }
}

// 兼容旧名
async function loadHsrMaze(offset = 0, preferKey = null, channel = 'live') {
  const modeKey =
    preferKey === 'memory'
      ? 'memory'
      : preferKey === 'story'
        ? 'story'
        : preferKey === 'boss'
          ? 'boss'
          : preferKey === 'peak'
            ? 'peak'
            : 'chaos'
  return loadHsrEndgame(modeKey, offset, channel)
}

async function listPeriods(game, channel = 'live') {
  const manifest = await getManifest()
  if (game === 'gi') {
    const version = pickGiVersion(manifest, channel)
    const overall = await fetchJson(`${STATIC}/gi/${version}/tower.json`)
    const list = pickLatestByEnd(overall)
    const ch = channelLabel(channel)
    // 正式服：以进行中为基准标注；下期：以最晚 end 为基准
    let baseIdx = list.length - 1
    if (channel === 'live') {
      const now = moment()
      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i]._begin
        const e = list[i]._end
        if (!b || !e) continue
        const begin = moment(b)
        const end = moment(e)
        if (begin.isValid() && end.isValid() && !begin.isAfter(now) && !end.isBefore(now)) {
          baseIdx = i
          break
        }
      }
    }
    const window = []
    for (let i = baseIdx; i >= 0 && window.length < 12; i--) {
      const x = list[i]
      const rel = baseIdx - i
      const tag = rel === 0 ? '【当期】' : `【上${rel}期】`
      window.push(
        `${tag} ${x.id} ${x.zh || x.en || ''} ${x._begin?.slice(0, 10) || ''} · ${ch} v${version}`,
      )
    }
    return window
  }
  if (game === 'gi-leyline') {
    const version = pickGiVersion(manifest, channel)
    const { list, picked } = await resolveLeylinePeriod(version, channel, 0)
    const ch = channelLabel(channel)
    const baseIdx = list.findIndex((x) => String(x.id) === String(picked.baseId))
    const bi = baseIdx >= 0 ? baseIdx : list.length - 1
    const window = []
    for (let i = bi; i >= 0 && window.length < 12; i--) {
      const x = list[i]
      const rel = bi - i
      const tag = rel === 0 ? '【当期】' : `【上${rel}期】`
      window.push(
        `${tag} ${x.id} ${x.zh || x.en || ''} ${x._begin?.slice(0, 10) || ''} · ${ch} v${version}`,
      )
    }
    return window
  }

  // 星铁各模式列表
  const modeKey =
    game === 'hsr-story'
      ? 'story'
      : game === 'hsr-boss'
        ? 'boss'
        : game === 'hsr-peak'
          ? 'peak'
          : game === 'hsr-memory'
            ? 'memory'
            : 'chaos'
  const mode = HSR_MODES[modeKey]
  const version = pickHsrVersion(manifest, channel)
  const overall = await fetchJson(`${STATIC}/hsr/${version}/${mode.overview}`)
  let list = Object.entries(overall || {})
    .filter(([id]) => mode.filterIds(id))
    .map(([id, v]) => ({ id: String(id), ...v }))
    .sort((a, b) => Number(a.id) - Number(b.id))
  const ch = channelLabel(channel)
  const picked = pickHsrByRank(list, 0, channel)
  const baseIdx = list.findIndex((x) => String(x.id) === String(picked?.baseId))
  const bi = baseIdx >= 0 ? baseIdx : list.length - 1
  const window = []
  for (let i = bi; i >= 0 && window.length < 12; i--) {
    const x = list[i]
    const rel = bi - i
    const tag = rel === 0 ? '【当期】' : `【上${rel}期】`
    window.push(`${tag} ${x.id} ${x.zh || x.en || ''} · ${ch} v${version}`)
  }
  return window
}

// ---------------- Plugin ----------------

export class nanokaAbyss extends plugin {
  constructor() {
    super({
      name: '[小花火]Nanoka版本深渊',
      dsc: 'Nanoka 原神/星铁版本深渊与挑战查询',
      event: 'message',
      priority: (cfg().abyss_priority ?? -98) + 1,
      rule: [
        {
          // #版本深渊=正式服；#下期深渊=下期包；可选 列表/上期/第N期
          reg: '^\\s*#?(?:下期深渊|下期螺旋|版本深渊|版本螺旋|螺旋版本|深渊版本)(?:列表|一览)?(?:上期|上一期|第\\d{1,3}期)?\\s*$',
          fnc: 'giTower',
        },
        {
          // #版本剧诗=正式；#下期剧诗=下期
          reg: '^\\s*#?(?:下期剧诗|版本剧诗|剧诗版本)(?:列表|一览)?(?:上期|上一期|第\\d{1,3}期)?\\s*$',
          fnc: 'giTheater',
        },
        {
          // #版本危战 / #下期危战 → Nanoka leyline 幽境危战
          reg: '^\\s*#?(?:下期危战|版本危战|危战版本)(?:列表|一览)?(?:上期|上一期|第\\d{1,3}期)?\\s*$',
          fnc: 'giHard',
        },
        {
          // 框架会把 * / 星铁 前缀标准化为「#星铁…」
          // *版本混沌→maze；*版本虚构→story；*版本末日→boss；*版本异相→peak
          reg: '^\\s*(?:#|\\*)?(?:\\*|星铁|#\\*|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)+(?:下期深渊|下期挑战|下期混沌|下期虚构|下期末日|下期异相|版本深渊|版本挑战|版本混沌|版本虚构|版本末日|版本异相|版本记忆|下期记忆)(?:列表|一览)?(?:上期|上一期|第\\d{1,3}期)?\\s*$',
          fnc: 'hsrMaze',
        },
      ],
    })
  }

  async giTower(e) {
    const msg = e.msg || ''
    const channel = parseChannel(msg)
    if (/列表|一览/.test(msg)) {
      try {
        const lines = await listPeriods('gi', channel)
        return e.reply(
          `Nanoka 原神深境螺旋（${channelLabel(channel)}）最近期数：\n${lines.join('\n')}\n——\n#版本深渊=正式服当期 · #下期深渊=下期`,
          true,
        )
      } catch (err) {
        return e.reply(`获取列表失败：${err.message}`, true)
      }
    }
    return this.renderMode(e, () => loadGiTower(listOffset(msg), channel), 'gi-tower')
  }

  async giTheater(e) {
    const msg = e.msg || ''
    const channel = parseChannel(msg)
    return this.renderMode(e, () => loadGiRoleCombat(listOffset(msg), channel), 'gi-theater')
  }

  async giHard(e) {
    const msg = e.msg || ''
    const channel = parseChannel(msg)
    if (/列表|一览/.test(msg)) {
      try {
        const lines = await listPeriods('gi-leyline', channel)
        return e.reply(
          `Nanoka 幽境危战（${channelLabel(channel)}）最近期数：\n${lines.join('\n')}\n——\n#版本危战=正式服 · #下期危战=下期`,
          true,
        )
      } catch (err) {
        return e.reply(`获取列表失败：${err.message}`, true)
      }
    }
    return this.renderMode(e, () => loadGiLeyline(listOffset(msg), channel), 'gi-leyline')
  }

  async hsrMaze(e) {
    const msg = e.msg || ''
    const channel = parseChannel(msg)
    // 模式路由
    let modeKey = 'chaos'
    if (/虚构/.test(msg)) modeKey = 'story'
    else if (/末日|幻影/.test(msg)) modeKey = 'boss'
    else if (/异相|仲裁|peak/i.test(msg)) modeKey = 'peak'
    else if (/记忆紊流|版本记忆|下期记忆/.test(msg)) modeKey = 'memory'
    else if (/混沌|深渊|挑战/.test(msg)) modeKey = 'chaos'

    const listGame =
      modeKey === 'story'
        ? 'hsr-story'
        : modeKey === 'boss'
          ? 'hsr-boss'
          : modeKey === 'peak'
            ? 'hsr-peak'
            : modeKey === 'memory'
              ? 'hsr-memory'
              : 'hsr'

    if (/列表|一览/.test(msg)) {
      try {
        const lines = await listPeriods(listGame, channel)
        return e.reply(
          `Nanoka ${HSR_MODES[modeKey].modeName}（${channelLabel(channel)}）最近期数：\n${lines.join('\n')}`,
          true,
        )
      } catch (err) {
        return e.reply(`获取列表失败：${err.message}`, true)
      }
    }
    return this.renderMode(
      e,
      () => loadHsrEndgame(modeKey, listOffset(msg), channel),
      `hsr-${modeKey}`,
    )
  }

  async renderMode(e, loader, saveId) {
    await replyProgress(e, '正在从 Nanoka 拉取版本数据…')
    let data
    try {
      data = this.trimPayload(await loader())
      data = await hydrateIcons(data)
    } catch (err) {
      logger?.error?.('[xhh-TL][nanokaAbyss]', err)
      return e.reply(`Nanoka 数据获取失败：${err.message || err}`, true)
    }

    try {
      if (!e.runtime?.render) {
        return e.reply('渲染引擎不可用（e.runtime.render）', true)
      }
      const buf = await this.renderToBuffer(
        e,
        {
          ...data,
          generatedAt: moment().format('YYYY-MM-DD HH:mm'),
          saveId,
        },
        saveId,
      )
      return this.sendImage(e, buf)
    } catch (err) {
      logger?.error?.('[xhh-TL][nanokaAbyss] render', err)
      return e.reply(`渲染失败：${err.message}`, true)
    }
  }

  /**
   * 截断过长内容，避免超长图导致 NTQQ rich media transfer failed
   */
  trimPayload(data) {
    const out = { ...data }
    // 模板友好字段
    if (Array.isArray(out.floors)) {
      out.floors = out.floors.map((f) => ({
        ...f,
        hasTypes: !!(f.type1?.length || f.type2?.length),
        hasSides: !!(f.left?.length || f.right?.length),
      }))
    }
    if (!out.gameName) out.gameName = out.game === 'hsr' ? 'HONKAI STAR RAIL' : 'GENSHIN IMPACT'

    // 原神深渊：只渲染 11 / 12 层，且从高到低（12 → 11）
    if (Array.isArray(out.floors) && out.game === 'gi' && out.mode === 'tower') {
      const keep = out.floors.filter((f) => {
        const n = Number(f.id ?? String(f.floorLabel || '').replace(/\D/g, ''))
        return n === 11 || n === 12
      })
      if (keep.length) {
        out.floors = keep.sort(
          (a, b) =>
            Number(b.id ?? String(b.floorLabel || '').replace(/\D/g, '')) -
            Number(a.id ?? String(a.floorLabel || '').replace(/\D/g, '')),
        )
      } else if (out.floors.length > 2) {
        // 无标准层号时退化为最高两层（保持从高到低）
        out.floors = out.floors.slice(-2).reverse()
      } else {
        out.floors = out.floors.slice().reverse()
      }
    }
    if (Array.isArray(out.floors) && out.game === 'hsr') {
      // 混沌：强制 12→9；其它模式已在 loader 里排好高→低
      if (out.mode === 'chaos' || out.mode === 'memory' || out.mode === 'maze') {
        const core = out.floors.filter((f) => {
          const n = Number(f.floorNo)
          return n >= 9 && n <= 12
        })
        if (core.length) {
          out.floors = core.sort((a, b) => (b.floorNo || 0) - (a.floorNo || 0))
        } else {
          out.floors = out.floors
            .slice()
            .sort((a, b) => (b.floorNo || b.index || 0) - (a.floorNo || a.index || 0))
            .slice(0, 4)
        }
      } else {
        out.floors = out.floors
          .slice()
          .sort((a, b) => (b.floorNo || b.index || 0) - (a.floorNo || a.index || 0))
      }
      // 模板字段（保留 hasStar / star / starCountdown）
      out.floors = out.floors.map((f) => ({
        ...f,
        hasTypes: !!(f.type1?.length || f.type2?.length || f.typeStar?.length),
        hasSides: !!(f.left?.length || f.right?.length || f.star?.length),
        hasStar: !!(f.hasStar || (f.star && f.star.length)),
      }))
    }
    if (Array.isArray(out.stages) && out.stages.length > 8) {
      out.stages = out.stages.slice(0, 8)
    }
    // 危战两列：压机制描述长度，避免图过高
    if (out.mode === 'leyline' && Array.isArray(out.diffColumns)) {
      out.diffColumns = out.diffColumns.map((col) => ({
        ...col,
        bosses: (col.bosses || []).slice(0, 3).map((b) => ({
          ...b,
          desc: b.desc && b.desc.length > 280 ? `${b.desc.slice(0, 280)}…` : b.desc,
        })),
      }))
    } else if (out.mode === 'leyline' && Array.isArray(out.stages)) {
      out.stages = out.stages.slice(0, 6).map((s) => ({
        ...s,
        desc: s.desc && s.desc.length > 320 ? `${s.desc.slice(0, 320)}…` : s.desc,
      }))
    }
    if (Array.isArray(out.floors)) {
      out.floors = out.floors.map((f) => ({
        ...f,
        desc: f.desc && f.desc.length > 180 ? `${f.desc.slice(0, 180)}…` : f.desc,
        challenges: (f.challenges || []).slice(0, 3),
      }))
    }
    if (out.buffDesc && out.buffDesc.length > 280) {
      out.buffDesc = `${out.buffDesc.slice(0, 280)}…`
    }
    return out
  }

  async renderToBuffer(e, data, saveId) {
    const renderConfig = cfg()
    const renderScale = getRenderScaleStyle(renderConfig, 1.6)
    const renderResult = await e.runtime.render('xhh-TL', 'nanoka_abyss', data, {
      retType: 'base64',
      imgType: 'png',
      beforeRender({ data: d }) {
        return {
          ...d,
          imgType: 'png',
          sys: {
            scale: renderScale,
          },
          ppath: '../../../../plugins/xhh-TL/resources/',
          tplFile: path.join(pluginDir, 'resources/nanoka_abyss/nanoka_abyss.html'),
          saveId,
        }
      },
    })

    let buf = null
    if (Buffer.isBuffer(renderResult)) {
      buf = renderResult
    } else if (typeof renderResult === 'string') {
      const s = renderResult.replace(/^base64:\/\//, '').replace(/^data:image\/\w+;base64,/, '')
      buf = Buffer.from(s, 'base64')
    } else if (renderResult?.file) {
      const f = renderResult.file
      if (Buffer.isBuffer(f)) buf = f
      else if (typeof f === 'string' && f.startsWith('base64://')) {
        buf = Buffer.from(f.slice(9), 'base64')
      } else if (typeof f === 'string' && f.startsWith('data:image')) {
        buf = Buffer.from(f.split(',')[1], 'base64')
      } else if (typeof f === 'string') {
        const fp = f.replace(/^file:\/\//, '')
        if (fs.existsSync(fp)) buf = fs.readFileSync(fp)
      }
    }
    if (!buf) return null

    try {
      buf = await sharp(buf)
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer()
    } catch (err) {
      logger?.debug?.(`[xhh-TL][nanokaAbyss] compress skip: ${err.message}`)
    }
    return buf
  }

  async sendImage(e, buf) {
    if (!buf) return replyQuote(e, '渲染失败，请稍后重试')
    // 单图引用触发消息
    try {
      return await replyQuote(e, segment.image(buf))
    } catch (err) {
      logger?.warn?.(`[xhh-TL][nanokaAbyss] send fail, retry: ${err.message}`)
      try {
        const fallback = await sharp(buf)
          .jpeg({ quality: 85, chromaSubsampling: '4:4:4', mozjpeg: true })
          .toBuffer()
        return await replyQuote(e, segment.image(fallback))
      } catch (err2) {
        return e.reply(`发图失败（图片可能过大）：${err2.message || err.message}`)
      }
    }
  }
}

export default nanokaAbyss
