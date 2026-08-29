/**
 * 星铁抽卡记录（米游社小程序同源接口）
 *
 * 数据来源是星铁微信小程序「抽卡记录」页面用的那一套：
 *   base  https://act-api-takumi.mihoyo.com/event/rpg_gacha_record
 *   /five_star_list  五星列表 + 当前垫抽（列表首条 item=null 的那条就是垫抽）
 *   /pool_stat       按卡池期次的统计，用来补 gacha_id / 卡池名
 * 鉴权跟战绩那套完全不同：先用米游社 cookie_token POST badge/v1/login/account
 * 换一枚 e_hkrpg_token，之后纯 Cookie 请求，没有 DS 签名。
 *
 * 接口本身的局限：**只有五星和垫抽数，没有四星、没有逐抽历史**。
 * 为了让 genshin 那套统计的「总抽数 / 保底进度」仍然成立，五星之间的空档用
 * rank_type=3 的占位记录补足。占位带 xhh_ph 标记，每次更新先清空再重建，
 * 所以反复更新不会累加、也不会污染真实记录（真实记录只增不删）。
 *
 * 指令（priority -Infinity，抢在 genshin gcLog(300) 和 xiaoyao-cvs 之前）：
 *   *更新抽卡记录   拉取并合并进 data/srJson/<QQ>/<UID>/<type>.json
 *   *抽卡记录       复用 genshin 的模板出图（数据已经并进它的库了）
 */

import fs from 'node:fs'
import path from 'node:path'
import moment from 'moment'
import fetch from 'node-fetch'
import plugin from '../../../lib/plugins/plugin.js'
import { getstoken, stokenToCookie, findStokenEntry, cookiePart } from '../utils/auth.js'
import { createUser } from '../utils/userBind.js'
import { ensureRuntime } from '../utils/runtimePatch.js'
import { config, pluginDir, getRenderScaleStyle } from '../utils/pluginConfig.js'
import { extractRenderBuffer } from '../utils/renderImage.js'
import { parseImportFile } from '../utils/gachaImport.js'
import { analyse, buildLine, getIcon, poolMax } from '../utils/gachaStat.js'

const BADGE_LOGIN = 'https://api-takumi.mihoyo.com/common/badge/v1/login/account'
const GACHA_BASE = 'https://act-api-takumi.mihoyo.com/event/rpg_gacha_record'
const REFERER = 'https://act.mihoyo.com/sr/event/gt-aio/gacha-records/index.html'
const UA =
  'Mozilla/5.0 (Linux; Android 13; V2183A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 miHoYoBBS/2.71.1'

/** 小程序的卡池枚举 → genshin srJson 的文件名（数字 gacha_type）。接口没有常驻池 */
const POOLS = [
  { key: 'GachaType_AvatarUp', type: '11', name: '角色活动跃迁' },
  { key: 'GachaType_EquipmentUp', type: '12', name: '光锥活动跃迁' },
  { key: 'GachaType_CollabAvatarUp', type: '21', name: '联动角色跃迁' },
  { key: 'GachaType_CollabEquipmentUp', type: '22', name: '联动光锥跃迁' },
  { key: 'GachaType_Newbie', type: '2', name: '新手跃迁' },
]

const ITEM_TYPE = { ItemType_Avatar: '角色', ItemType_Equipment: '光锥' }

/** 占位记录借用一个真实存在的三星光锥，避免出图时反查图标失败 */
const PLACEHOLDER = { item_id: '20006', name: '智库', item_type: '光锥' }

const SR_JSON_DIR = path.join(process.cwd(), 'data', 'srJson')

/** 卡池期次统计的落盘缓存：更新时顺手存下来，出图时不必再请求接口 */
const POOL_CACHE = path.join(pluginDir, 'data', 'sr_gacha_pools.json')

function readPoolCache() {
  try {
    if (fs.existsSync(POOL_CACHE)) return JSON.parse(fs.readFileSync(POOL_CACHE, 'utf8')) || {}
  } catch (_) {}
  return {}
}

function savePoolCache(uid, type, cards) {
  const all = readPoolCache()
  const key = String(uid)
  all[key] = all[key] || {}
  all[key][String(type)] = { at: Date.now(), cards: cards || [] }
  try {
    fs.mkdirSync(path.dirname(POOL_CACHE), { recursive: true })
    fs.writeFileSync(POOL_CACHE, JSON.stringify(all, null, 1))
  } catch (err) {
    logger?.debug?.(`[xhh-TL][抽卡记录] 卡池缓存写入失败：${err.message}`)
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** id 前 10 位是秒级时间戳（是卡池批次时间，不是精确抽卡时刻，误差在小时级） */
function idToTime(id) {
  const sec = Number(String(id).slice(0, 10))
  if (!sec) return moment().format('YYYY-MM-DD HH:mm:ss')
  return moment.unix(sec).format('YYYY-MM-DD HH:mm:ss')
}

async function api(url, { cookie, body, timeout = 20000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        'User-Agent': UA,
        Cookie: cookie,
        Origin: 'https://act.mihoyo.com',
        Referer: REFERER,
        ...(body ? { 'Content-Type': 'application/json;charset=UTF-8' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    let setCookie = []
    try {
      setCookie = res.headers.raw?.()['set-cookie'] || []
    } catch (_) {}
    return { json: await res.json().catch(() => null), setCookie }
  } finally {
    clearTimeout(timer)
  }
}

/** 米游社 cookie → 抽卡记录专用 cookie（追加 e_hkrpg_token） */
async function badgeLogin(mysCookie, uid, region) {
  const { json, setCookie } = await api(BADGE_LOGIN, {
    cookie: mysCookie,
    body: { game_biz: 'hkrpg_cn', lang: 'zh-cn', region: region || 'prod_gf_cn', uid: String(uid) },
  })
  if (json?.retcode !== 0) {
    throw new Error(`换取抽卡记录凭证失败：${json?.message || '接口无响应'}（${json?.retcode}）`)
  }
  const act = setCookie
    .filter(c => !/^aliyungf_tc=/.test(c))
    .map(c => c.split(';')[0])
    .join(';')
  if (!/e_hkrpg_token=/.test(act)) throw new Error('接口没有下发 e_hkrpg_token，凭证可能已失效')
  return `${mysCookie};${act}`
}

/**
 * 拉某个池的全部五星。
 * 分页有坑：翻页必须同时回传上一页的 version_id 和 max_id=next_max_id；
 * 只传 max_id 的话服务端忽略分页、永远返回第一页且 has_more 恒 true。
 */
async function fetchFiveStars(cookie, poolKey) {
  const list = []
  let versionId = '0'
  let maxId = '0'
  let pity = null
  for (let guard = 0; guard < 30; guard++) {
    const q = new URLSearchParams({ gacha_type: poolKey, version_id: versionId, max_id: maxId })
    const { json } = await api(`${GACHA_BASE}/five_star_list?${q}`, { cookie })
    if (json?.retcode !== 0) {
      throw new Error(`拉取五星列表失败：${json?.message || '接口无响应'}（${json?.retcode}）`)
    }
    const d = json.data || {}
    for (const node of d.list || []) {
      // 首条 item=null 的是「当前垫抽」，不是一条抽卡记录
      if (node.item) list.push(node)
      else if (pity === null) pity = Number(node.gacha_count) || 0
    }
    if (!d.has_more || !d.next_max_id || d.next_max_id === '0') break
    versionId = d.version_id
    maxId = d.next_max_id
    await sleep(300)
  }
  return { list, pity: pity || 0 }
}

/** 卡池期次统计，用来给记录补 gacha_id（按 up 五星的 item_id 对应） */
async function fetchPoolStat(cookie, poolKey) {
  const q = new URLSearchParams({ gacha_type: poolKey })
  const { json } = await api(`${GACHA_BASE}/pool_stat?${q}`, { cookie })
  const cards = json?.retcode === 0 ? json.data?.cards || [] : []
  const byUpItem = new Map()
  for (const c of cards) {
    const up = c.up_item?.item_id
    if (up && c.gacha_id) byUpItem.set(String(up), String(c.gacha_id))
  }
  return { cards, byUpItem }
}

function logFile(userId, uid, type) {
  return path.join(SR_JSON_DIR, String(userId), String(uid), `${type}.json`)
}

function readLocal(userId, uid, type) {
  const file = logFile(userId, uid, type)
  if (!fs.existsSync(file)) return []
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(arr) ? arr : []
  } catch (err) {
    logger?.error?.(`[xhh-TL][抽卡记录] 读取 ${file} 失败：${err.message}`)
    return []
  }
}

function writeLocal(userId, uid, type, list) {
  const dir = path.join(SR_JSON_DIR, String(userId), String(uid))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(logFile(userId, uid, type), JSON.stringify(list, '', '\t'))
}

function toRecord(uid, type, node, gachaId) {
  const item = node.item
  return {
    uid: String(uid),
    gacha_id: gachaId || '',
    gacha_type: String(type),
    item_id: String(item.item_id),
    count: '1',
    time: idToTime(node.id),
    name: item.name,
    lang: 'zh-cn',
    item_type: ITEM_TYPE[item.item_type] || '角色',
    rank_type: String(item.rarity || 5),
    id: String(node.id),
    xhh_src: 'mini',
  }
}

function makePlaceholder(uid, type, id, time, gachaId) {
  return {
    uid: String(uid),
    gacha_id: gachaId || '',
    gacha_type: String(type),
    item_id: PLACEHOLDER.item_id,
    count: '1',
    time,
    name: PLACEHOLDER.name,
    lang: 'zh-cn',
    item_type: PLACEHOLDER.item_type,
    rank_type: '3',
    id: String(id),
    xhh_ph: 1,
  }
}

const big = id => {
  try {
    return BigInt(String(id).replace(/\D/g, '') || '0')
  } catch (_) {
    return 0n
  }
}

/** 在 (lowId, highId) 开区间里生成 count 条占位，跳过已被占用的 id */
function buildPlaceholders(uid, type, highId, lowId, count, usedIds, time, gachaId) {
  const out = []
  let cur = highId - 1n
  while (out.length < count && cur > lowId) {
    const key = String(cur)
    if (!usedIds.has(key)) {
      out.push(makePlaceholder(uid, type, key, time, gachaId))
      usedIds.add(key)
    }
    cur -= 1n
  }
  return out
}

/**
 * 判重键：item_id + id 前 10 位（秒级批次时间戳）。
 * 小程序接口和游戏内 authkey 接口是两套 id —— 前 10 位时间戳一致、后 9 位序号各编各的，
 * 所以不能直接比 id 全串，否则同一个五星会被当成新记录重复写入。
 */
const dupKey = (itemId, id) => `${itemId}@${String(id).slice(0, 10)}`

/**
 * 把接口拿到的五星 + 垫抽并进本地某个池的记录。
 * 真实记录只增不删；占位每次重建，所以重复执行不会累加。
 */
function mergePool(userId, uid, type, remote, poolStat) {
  const local = readLocal(userId, uid, type)
  const real = local.filter(r => !r.xhh_ph)
  const usedIds = new Set(real.map(r => String(r.id)))
  // 「已导入区间」只由完整逐抽来源（抽卡链接导入、导入 json）界定。
  // 我们自己写进去的 mini 五星不算，否则第二次更新会把区间误判成完整、不再重建占位
  const maxFullId = real
    .filter(r => r.xhh_src !== 'mini')
    .reduce((m, r) => (big(r.id) > m ? big(r.id) : m), 0n)

  // 本地五星按判重键分桶，接口里的同键记录逐个抵扣
  const buckets = new Map()
  for (const r of real) {
    if (String(r.rank_type) !== '5') continue
    const k = dupKey(r.item_id, r.id)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(r)
  }

  const stars = remote.list
  const added = []
  const notes = []
  let added5 = 0
  let addedPh = 0
  let skipped = 0

  /** 给某个五星补它之前的垫抽占位。anchorId 是这条五星在本地的 id */
  const fillGap = (s, i, anchorId, gachaId) => {
    const gap = Number(s.gacha_count) - 1
    if (gap <= 0) return
    const prevId = stars[i + 1] ? big(stars[i + 1].id) : 0n
    // 垫抽区间是 (prevId, anchorId)。完整记录若落在区间内，这段本来就有真实数据，
    // 再补占位等于把抽数算两遍
    if (maxFullId > prevId && maxFullId < anchorId) {
      notes.push(`${s.item.name}(${s.gacha_count}抽) 的垫抽跨入已导入区间，未补占位以避免重复计数`)
      return
    }
    if (maxFullId >= anchorId) return
    const phs = buildPlaceholders(uid, type, anchorId, prevId, gap, usedIds, idToTime(s.id), gachaId)
    added.push(...phs)
    addedPh += phs.length
    if (phs.length < gap) notes.push(`${s.item.name} 的占位只补到 ${phs.length}/${gap} 条`)
  }

  for (let i = 0; i < stars.length; i++) {
    const s = stars[i]
    const k = dupKey(s.item.item_id, s.id)
    const gachaId = poolStat.byUpItem.get(String(s.item.item_id)) || ''
    const hit = buckets.get(k)?.shift()
    if (hit) {
      skipped++
      // 上一轮就是我们写进去的，它的占位刚被清掉，要按同样规则重建
      if (hit.xhh_src === 'mini') fillGap(s, i, big(hit.id), gachaId)
      continue
    }
    added.push(toRecord(uid, type, s, gachaId))
    usedIds.add(String(s.id))
    added5++
    fillGap(s, i, big(s.id), gachaId)
  }

  // 当前垫抽：最新五星之后又抽了 pity 抽还没出货
  if (remote.pity > 0) {
    const lastStarId = stars[0] ? big(stars[0].id) : 0n
    if (maxFullId > lastStarId) {
      notes.push(`当前垫抽 ${remote.pity} 抽跨入已导入区间，未补占位`)
    } else {
      const nowId = BigInt(Math.floor(Date.now() / 1000)) * 1000000000n
      const phs = buildPlaceholders(
        uid,
        type,
        nowId,
        lastStarId,
        remote.pity,
        usedIds,
        moment().format('YYYY-MM-DD HH:mm:ss'),
        '',
      )
      added.push(...phs)
      addedPh += phs.length
    }
  }

  const changed = added.length > 0 || local.length !== real.length
  if (changed) {
    const merged = [...added, ...real].sort((a, b) => {
      const x = big(a.id)
      const y = big(b.id)
      return y > x ? 1 : y < x ? -1 : 0
    })
    writeLocal(userId, uid, type, merged)
    return { added5, addedPh, skipped, notes, changed, total: merged.length }
  }
  return { added5, addedPh, skipped, notes, changed, total: local.length }
}

/** 星铁 UID：绑定库 → redis → 已有记录目录 */
async function resolveSrUid(e) {
  try {
    const user = await createUser(e.user_id, e)
    const uid = user?.getUid?.('sr')
    if (uid) return { uid: String(uid), user }
  } catch (err) {
    logger?.debug?.(`[xhh-TL][抽卡记录] createUser 失败：${err.message}`)
  }
  try {
    const v = await redis?.get?.(`Yz:srJson:mys:qq-uid:${e.user_id}`)
    if (v) return { uid: String(v), user: null }
  } catch (_) {}
  try {
    const subs = fs
      .readdirSync(path.join(SR_JSON_DIR, String(e.user_id)))
      .filter(d => /^\d+$/.test(d))
    if (subs.length === 1) return { uid: subs[0], user: null }
  } catch (_) {}
  return { uid: '', user: null }
}

/** 星铁 region 按 UID 首位推断。yaml 里的 region 常常是原神的（cn_gf01），直接拿来用会被判 -1002 */
function guessSrRegion(uid) {
  switch (String(uid)[0]) {
    case '5':
      return 'prod_qd_cn'
    case '6':
      return 'prod_official_usa'
    case '7':
      return 'prod_official_eur'
    case '8':
      return 'prod_official_asia'
    case '9':
      return 'prod_official_cht'
    default:
      return 'prod_gf_cn'
  }
}

/** stoken v2 换新鲜 cookie_token。走 passport-api（老的 api-takumi/auth 那个对 v2_ 开头的 stoken 会失败） */
async function fetchCookieToken(stuid, stoken, mid) {
  const res = await fetch(
    'https://passport-api.mihoyo.com/account/auth/api/getCookieAccountInfoBySToken',
    {
      headers: {
        'x-rpc-app_id': 'bll8iq97cem8',
        'User-Agent': 'okhttp/4.9.3',
        Cookie: `stuid=${stuid};stoken=${stoken}${mid ? `;mid=${mid}` : ''}`,
      },
      timeout: 15000,
    },
  )
  const json = await res.json().catch(() => null)
  const ct = json?.data?.cookie_token
  if (!ct) throw new Error(`换取 cookie_token 失败：${json?.message || '无响应'}（${json?.retcode}）`)
  return ct
}

/** 取该 UID 可用的米游社 cookie（必须含 cookie_token）与所在区服 */
async function prepareCookie(e, uid, user) {
  // getstoken 返回的是 cookie 串（不是对象）
  const raw = await getstoken(e.user_id, uid, e)
  if (!raw) {
    throw new Error('没找到可用的米游社凭证，请先扫码登录或 #绑定ck（需要 stoken）')
  }
  const src = typeof raw === 'string' ? raw : raw.ck_stoken || raw.ck || ''
  const yamlEntry = findStokenEntry(e.user_id, String(uid)) || {}
  const stuid =
    cookiePart(src, 'stuid') ||
    cookiePart(src, 'ltuid') ||
    cookiePart(src, 'account_id') ||
    yamlEntry.stuid ||
    ''
  const stoken = cookiePart(src, 'stoken') || yamlEntry.stoken || ''
  const mid = cookiePart(src, 'mid') || yamlEntry.mid || ''

  let cookie = ''
  if (stuid && stoken) {
    try {
      cookie = `account_id=${stuid};cookie_token=${await fetchCookieToken(stuid, stoken, mid)}`
    } catch (err) {
      logger?.debug?.(`[xhh-TL][抽卡记录] passport 换 cookie_token 失败：${err.message}`)
    }
  }
  if (!cookie) {
    // 兜底：插件既有的换取逻辑，或本身就是含 cookie_token 的完整 ck
    const fallback = await stokenToCookie(typeof raw === 'string' ? { ck_stoken: raw } : raw)
    if (/cookie_token=/.test(fallback || '')) cookie = fallback
  }
  if (!cookie) {
    throw new Error('拿不到 cookie_token，stoken 可能已失效，重新扫码登录一次试试')
  }

  // 只认星铁自己的 region 命名，其余（比如 yaml 里混进来的原神 cn_gf01）按 UID 推断
  const candidates = [
    (user?.getUidList?.('sr') || []).find(x => String(x.uid) === String(uid))?.region,
    yamlEntry.sr_region,
    String(uid) === String(yamlEntry.uid) ? yamlEntry.region : '',
  ]
  const region = candidates.find(r => /^prod_/.test(String(r || ''))) || guessSrRegion(uid)
  return { cookie, region }
}


/** 数字 gacha_type → 小程序里的池名 */
const POOL_LABEL = Object.fromEntries(POOLS.map(p => [p.type, p.name]))
POOL_LABEL['1'] = '常驻跃迁'

/** 从消息里的文件段或链接取出导入文件 */
async function fetchImportFile(e) {
  let url = ''
  let name = ''
  if (e.file) {
    name = e.file.name || ''
    url = e.file.url || ''
    if (!/^https?:\/\//.test(url) && e.file.fid) {
      url = (await e.group?.getFileUrl?.(e.file.fid)) || (await e.friend?.getFileUrl?.(e.file.fid)) || ''
    }
  }
  if (!/^https?:\/\//.test(url)) {
    url = String(e.msg || '').match(/https?:\/\/[^\s]+/i)?.[0]?.replace(/[)>】」』"'，。！？；;]+$/g, '') || ''
    if (url && !name) {
      try {
        name = decodeURIComponent(path.basename(new URL(url).pathname || ''))
      } catch (_) {}
    }
  }
  if (!/^https?:\/\//.test(url)) return null

  const res = await fetch(url, { headers: { 'User-Agent': UA }, timeout: 60000 })
  if (!res.ok) throw new Error(`下载文件失败：HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('下载到的文件是空的')
  if (buf.length > 40 * 1024 * 1024) throw new Error('文件太大（超过 40MB）')
  return { buf, name }
}

/** 按 id 倒序（新的在前），和 genshin 写入的顺序保持一致 */
function byIdDesc(a, b) {
  const x = big(a.id)
  const y = big(b.id)
  return y > x ? 1 : y < x ? -1 : 0
}

/** Excel 之类不带 id 的记录：按时间造一个可排序的伪 id，打 xhh_fid 标记 */
function assignIds(records) {
  const times = records.map(r => Date.parse(String(r.time).replace(/-/g, '/'))).filter(Boolean)
  // 文件里可能是旧→新，统一翻成新→旧，保证同一秒内的顺序不乱
  if (times.length > 1 && times[0] < times[times.length - 1]) records.reverse()

  const seq = new Map()
  let made = 0
  for (const r of records) {
    if (r.id) continue
    const ms = Date.parse(String(r.time).replace(/-/g, '/'))
    if (!ms) continue
    const sec = Math.floor(ms / 1000)
    const n = seq.has(sec) ? seq.get(sec) - 1 : 999999999
    seq.set(sec, n)
    r.id = String(BigInt(sec) * 1000000000n + BigInt(n))
    r.xhh_fid = 1
    made++
  }
  return made
}

/**
 * 导入的记录并进本地库。
 * 导入进来的是真实（通常是完整逐抽）记录，所以：旧占位全部丢弃、
 * 落在导入范围内的小程序五星让位给真实记录，避免同一抽被算两遍。
 */
function mergeImport(userId, uid, records) {
  const byType = new Map()
  for (const r of records) {
    const t = String(r.gacha_type)
    if (!byType.has(t)) byType.set(t, [])
    byType.get(t).push({ ...r, uid: String(uid) })
  }

  const stat = { added: 0, skipped: 0, dropMini: 0, dropPh: 0, pools: [] }
  for (const [type, list] of byType) {
    const local = readLocal(userId, uid, type)
    const localReal = local.filter(r => !r.xhh_ph)
    const dropPh = local.length - localReal.length

    const ids = new Set(localReal.map(r => String(r.id)))
    const keyOf = r => `${r.time}|${r.name}`
    const keyCount = new Map()
    for (const r of localReal) keyCount.set(keyOf(r), (keyCount.get(keyOf(r)) || 0) + 1)

    const add = []
    for (const r of list) {
      if (r.id && ids.has(String(r.id))) {
        stat.skipped++
        continue
      }
      const k = keyOf(r)
      if (keyCount.get(k) > 0) {
        keyCount.set(k, keyCount.get(k) - 1)
        stat.skipped++
        continue
      }
      add.push(r)
      if (r.id) ids.add(String(r.id))
    }

    // 只有真的并进了新记录，才动本地：让同一个五星的小程序记录退位、顺带重建占位。
    // 全是重复的时候一个字节都不改，免得白清掉占位丢了垫抽进度。
    if (!add.length) {
      stat.skipped += 0
      continue
    }

    const coverKeys = new Set()
    for (const r of add) {
      coverKeys.add(`b:${r.item_id}@${String(r.id).slice(0, 10)}`)
      if (r.time) coverKeys.add(`d:${r.item_id}@${String(r.time).slice(0, 10)}`)
    }
    let dropMini = 0
    const kept = localReal.filter(r => {
      if (r.xhh_src !== 'mini') return true
      // 小程序的 id 与游戏内导出前 10 位（批次时间戳）一致，Excel 的伪 id 只能按日期对
      const covered =
        coverKeys.has(`b:${r.item_id}@${String(r.id).slice(0, 10)}`) ||
        (r.time && coverKeys.has(`d:${r.item_id}@${String(r.time).slice(0, 10)}`))
      if (covered) {
        dropMini++
        return false
      }
      return true
    })

    // 只有当真实记录顶掉了小程序五星，占位才失去意义（它们是挂在那些五星上的）；
    // 否则原样留着，别让一次小规模导入把垫抽进度清光
    const phKept = dropMini ? [] : local.filter(r => r.xhh_ph)
    writeLocal(userId, uid, type, [...add, ...kept, ...phKept].sort(byIdDesc))
    stat.added += add.length
    stat.dropPh += dropMini ? dropPh : 0
    stat.dropMini += dropMini
    stat.pools.push(`${POOL_LABEL[type] || type} +${add.length}`)
  }
  return stat
}

/** 记录缺 name / 星级 / 类型时，用 miao 的星铁元数据按名字或 item_id 补齐 */
async function fillMeta(records) {
  let models
  try {
    // 不能写 '#miao.models'：xhh-TL 自己带 package.json，Node 会在本插件里找 imports 字段而解析失败
    models = await import('../../miao-plugin/models/index.js')
  } catch (err) {
    logger?.debug?.(`[xhh-TL][抽卡记录] 载入 miao 元数据失败，跳过补齐：${err.message}`)
    return 0
  }
  const { Character, Weapon } = models
  let filled = 0
  for (const r of records) {
    if (r.name && r.rank_type && r.item_type) continue
    const key = r.name || Number(r.item_id) || ''
    if (!key) continue
    const isChar = r.item_type === '角色' || String(r.item_id).length === 4
    const meta = isChar ? Character?.get?.(key, 'sr') : Weapon?.get?.(key, 'sr')
    if (!meta) continue
    r.name = r.name || meta.name || ''
    r.item_type = r.item_type || (isChar ? '角色' : '光锥')
    r.rank_type = r.rank_type || String(meta.star || meta.rank || '')
    r.item_id = r.item_id || String(meta.id || '')
    filled++
  }
  return filled
}

/** 顶部 tab 固定这三个，当前池不在其中时顶掉第三个 */
const TAB_TYPES = ['11', '12', '21']

/** 指令里的池名 → gacha_type（原来靠 genshin 的 getPool 解析，现在自己来） */
function parsePoolType(msg = '') {
  const key = String(msg)
    .replace(/#|星铁|崩坏星穹铁道|铁道|抽卡|抽奖|记录|祈愿|分析|池|全部|\s/g, '')
    .trim()
  switch (key) {
    case '常驻':
      return '1'
    case '新手':
      return '2'
    case '武器':
    case '光锥':
      return '12'
    case '角色联动':
      return '21'
    case '武器联动':
    case '光锥联动':
      return '22'
    default:
      // 抽卡 / 抽奖 / 角色 / up / 空
      return '11'
  }
}

/** 组装小程序风格出图所需数据。只读本地记录自己算，不依赖 genshin 插件 */
async function buildViewData(e, uid) {
  if (!uid) return null
  const type = parsePoolType(e.msg)
  const list = readLocal(e.user_id, uid, type)
  if (!list.length) return null

  const stat = analyse(list, type)
  const max = poolMax(type)
  const pct = n => Math.max(6, Math.min(100, (Number(n) / max) * 100))

  const fiveLog = []
  for (const it of stat.fiveLog) {
    fiveLog.push({ ...it, icon: await getIcon(it.name, it.item_type) })
  }

  const rows = [
    { placeholder: true, name: '已跃迁', num: stat.noFiveNum, pct: pct(stat.noFiveNum) },
    ...fiveLog.map(x => ({
      icon: x.icon,
      name: x.name,
      num: x.num,
      isUp: x.isUp,
      pct: pct(x.num),
    })),
  ]

  const cards = (readPoolCache()[String(uid)]?.[type]?.cards || []).slice(0, 3)
  const poolCards = []
  for (const c of cards) {
    poolCards.push({
      poolName: c.pool_name || '未知卡池',
      version: c.version ? `v${String(c.version).split('.').slice(0, 2).join('.')}` : '',
      total: c.total_count ?? 0,
      upCount: c.up_count ?? 0,
      upName: c.up_item?.name || '',
      icon: c.up_item?.name
        ? await getIcon(c.up_item.name, ITEM_TYPE[c.up_item.item_type] || '角色')
        : '',
    })
  }

  const tabs = TAB_TYPES.slice()
  if (!tabs.includes(type)) tabs[2] = type

  return {
    uid: String(uid),
    poolName: POOL_LABEL[type] || `${type} 号池`,
    tabs: tabs.map(t => ({ name: POOL_LABEL[t] || t, active: t === type })),
    // 本地有多少五星就渲染多少，不截断
    recent5: fiveLog,
    poolCards,
    list: rows,
    stats: buildLine(stat, type),
    allNum: stat.allNum,
    fiveNum: fiveLog.length,
    firstTime: stat.firstTime,
    lastTime: stat.lastTime,
    updatedAt: moment().format('MM-DD HH:mm'),
  }
}

export class srGachaLog extends plugin {
  constructor() {
    super({
      name: '星铁抽卡记录',
      dsc: '米游社小程序同源接口：拉五星记录并合并进本地抽卡记录',
      event: 'message',
      // 抢在 genshin gcLog(300) 与 xiaoyao-cvs 之前，避免这两条指令被别的插件接走
      priority: -Infinity,
      rule: [
        { reg: '^\\s*#?星铁(?:强制)?(?:更新|获取)抽卡记录\\s*$', fnc: 'updateLog' },
        {
          // 允许「*导入记录」后面直接跟文件直链，也支持只发指令+附件
          reg: '^\\s*#?星铁(?:强制)?导入(?:抽卡)?记录(?:json|excel|xlsx)?(?:\\s+\\S+)?\\s*$',
          fnc: 'importLog',
        },
        // 单个卡池的记录都走小程序风格新图；「全部」系列（*全部记录 / *全部抽卡记录）
        // 故意不匹配，留给 genshin 的四合一模板
        {
          reg:
            '^\\s*#?星铁(?:抽卡|抽奖|角色联动|角色|武器联动|武器|光锥联动|光锥|常驻|up|UP|新手)' +
            '池?(?:记录|祈愿|分析)\\s*$',
          fnc: 'viewLog',
        },
      ],
    })
  }

  /** *抽卡记录 —— 数据已经并进 genshin 的库，直接借它的模板出图 */
  /** *抽卡记录 / *武器记录 / *光锥记录 …—— 单池记录，走小程序风格新图 */
  async viewLog() {
    this.e.isSr = true
    // 出图走 e.runtime.render；正常事件链上一定有，这里只是兜住被别处转发来的 e
    if (!this.e.runtime?.render) await ensureRuntime(this.e)
    return this.renderMini()
  }

  /** 小程序「跃迁记录统计」风格出图 */
  async renderMini() {
    if (!this.e.runtime?.render) await ensureRuntime(this.e)
    const { uid } = await resolveSrUid(this.e)
    const data = await buildViewData(this.e, uid)
    if (!data) {
      await this.reply('还没有抽卡记录，先发 *更新抽卡记录 试试', false, { at: true })
      return true
    }
    const tplFile = path.join(pluginDir, 'resources/gachaLog/gachaLog.html')
    // 1 倍图在手机上看着糊，这里放大渲染再压 jpeg
    const renderScale = getRenderScaleStyle(config(), 1.6)
    const res = await this.e.runtime.render('xhh-TL', 'gachaLog', data, {
      retType: 'base64',
      imgType: 'jpeg',
      beforeRender: ({ data: d }) => ({
        ...d,
        imgType: 'jpeg',
        sys: { scale: renderScale },
        ppath: '../../../../plugins/xhh-TL/resources/',
        tplFile,
        saveId: `gachaLog-${data.uid}-${data.poolName}`,
      }),
    })
    const img = extractRenderBuffer(res)
    if (!img) {
      await this.reply('抽卡记录出图失败，请稍后重试', false, { at: true })
      return true
    }
    await this.reply(segment.image(img))
    return true
  }

  /** *更新抽卡记录 */
  async updateLog() {
    this.e.isSr = true
    const { uid, user } = await resolveSrUid(this.e)
    if (!uid) {
      await this.reply('没找到你的星铁 UID，先绑定账号再更新哦', false, { at: true })
      return true
    }
    await this.reply('崩铁抽卡记录更新中，请稍等...', false, { at: true })
    try {
      const { cookie, region } = await prepareCookie(this.e, uid, user)
      const gachaCookie = await badgeLogin(cookie, uid, region)
      // 更新完不发文案，统计只落日志，直接出图
      logger?.info?.(`[xhh-TL][抽卡记录] ${uid} ${await this.runUpdate(uid, gachaCookie)}`)
      await this.renderMini()
    } catch (err) {
      logger?.error?.(`[xhh-TL][抽卡记录] ${uid} 更新失败：${err.stack || err.message}`)
      await this.reply(`崩铁抽卡记录更新失败：${err.message}`, false, { at: true })
    }
    return true
  }

  /** *导入记录 —— 支持 SRGF v1.0 / UIGF v2.x / UIGF v4.x / Excel(xlsx) */
  async importLog() {
    this.e.isSr = true
    if (this.e.isGroup && !/强制/.test(this.e.msg)) {
      await this.reply('导入的文件里有你的抽卡记录，建议私聊导入；确认要在群里导入请发【*强制导入记录】', false, {
        at: true,
      })
      return true
    }
    let file
    try {
      file = await fetchImportFile(this.e)
    } catch (err) {
      await this.reply(`取文件失败：${err.message}`, false, { at: true })
      return true
    }
    if (!file) {
      await this.reply(
        '把导出的文件（SRGF v1.0 / UIGF v4.x / UIGF v2.x 的 json，或 Excel .xlsx）连同这条指令一起发给我，或者附上文件直链',
        false,
        { at: true },
      )
      return true
    }

    try {
      const parsed = parseImportFile(file.buf, file.name)
      if (!parsed.records.length) throw new Error('文件里没有解析出任何记录')

      const { uid: localUid } = await resolveSrUid(this.e)
      const uid = parsed.uid || localUid
      if (!uid) throw new Error('文件里没有 UID，你也还没绑定星铁 UID')
      if (parsed.uids?.length > 1) {
        logger?.info?.(`[xhh-TL][抽卡记录] 导入文件含多个 UID：${parsed.uids.join(',')}，只用 ${uid}`)
      }

      await fillMeta(parsed.records)
      const faked = assignIds(parsed.records)
      const stat = mergeImport(this.e.user_id, uid, parsed.records)

      const detail = [
        `${parsed.format} 导入完成`,
        `新增 ${stat.added} 条`,
        stat.skipped ? `重复跳过 ${stat.skipped} 条` : '',
        stat.dropMini ? `${stat.dropMini} 条小程序五星已被真实记录替换` : '',
        stat.dropPh ? `清理占位 ${stat.dropPh} 条` : '',
        faked ? `${faked} 条无 id 记录按时间补了序号` : '',
        stat.pools.length ? stat.pools.join('、') : '',
      ]
        .filter(Boolean)
        .join('；')
      await this.reply(`${detail}。`, false, { at: true })
      logger?.info?.(`[xhh-TL][抽卡记录] ${uid} ${detail}`)
      if (stat.dropPh) {
        await this.reply('占位记录已随导入清掉，想恢复小程序侧的垫抽进度再发一次 *更新抽卡记录', false, {
          at: true,
        })
      }
      await this.renderMini()
    } catch (err) {
      logger?.error?.(`[xhh-TL][抽卡记录] 导入失败：${err.stack || err.message}`)
      await this.reply(`导入失败：${err.message}`, false, { at: true })
    }
    return true
  }

  /** 逐池拉取 → 合并 → 组装汇总文案 */
  async runUpdate(uid, gachaCookie) {
    const userId = this.e.user_id
    const lines = []
    const pityParts = []
    const notes = []
    let added5 = 0
    let addedPh = 0
    let skipped = 0
    let remoteTotal = 0

    for (const pool of POOLS) {
      const remote = await fetchFiveStars(gachaCookie, pool.key)
      const poolStat = await fetchPoolStat(gachaCookie, pool.key)
      savePoolCache(uid, pool.type, poolStat.cards)
      const res = mergePool(userId, uid, pool.type, remote, poolStat)

      added5 += res.added5
      addedPh += res.addedPh
      skipped += res.skipped
      remoteTotal += remote.list.length
      notes.push(...res.notes)
      if (remote.pity > 0) pityParts.push(`${pool.name}${remote.pity}抽`)
      lines.push(`${pool.name} 五星${remote.list.length}条`)
      await sleep(400)
    }

    // 结果直接出图，这段只进日志，方便回查合并细节
    return [
      `新增五星 ${added5} 条（接口给出 ${remoteTotal} 条，${skipped} 条本地已有）`,
      `占位 ${addedPh} 条`,
      pityParts.length ? `垫抽 ${pityParts.join('/')}` : '',
      lines.join(' '),
      ...notes,
    ]
      .filter(Boolean)
      .join('；')
  }
}






