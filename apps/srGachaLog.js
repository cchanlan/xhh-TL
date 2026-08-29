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
/** 顶部 tab 固定这三个，当前池不在其中时顶掉第三个 */
const TAB_TYPES = ['11', '12', '21']

/** 组装小程序风格出图所需数据，全部取自 genshin 的抽卡记录库 */
async function buildViewData(e, uid) {
  const { default: GachaLog } = await import('../../genshin/model/gachaLog.js')
  const data = await new GachaLog(e).getLogData()
  if (!data) return null

  const type = String(data.type)
  const max = Number(data.max) || 90
  const pity = Number(data.line?.[0]?.[0]?.num) || 0
  const pct = n => Math.max(6, Math.min(100, (Number(n) / max) * 100))

  const fiveLog = data.fiveLog || []
  const list = [
    { placeholder: true, name: '已跃迁', num: pity, pct: pct(pity) },
    ...fiveLog.map(x => ({
      icon: x.icon,
      name: x.name,
      num: x.num,
      isUp: x.isUp,
      pct: pct(x.num),
    })),
  ]

  const cards = (readPoolCache()[String(data.uid || uid)]?.[type]?.cards || []).slice(0, 3)
  const poolCards = cards.map(c => ({
    poolName: c.pool_name || '未知卡池',
    version: c.version ? `v${String(c.version).split('.').slice(0, 2).join('.')}` : '',
    total: c.total_count ?? 0,
    upCount: c.up_count ?? 0,
    upName: c.up_item?.name || '',
    icon: c.up_item?.name
      ? GachaLog.getIcon(c.up_item.name, ITEM_TYPE[c.up_item.item_type] || '角色', 'sr') || ''
      : '',
  }))

  const tabs = TAB_TYPES.slice()
  if (!tabs.includes(type)) tabs[2] = type

  return {
    uid: data.uid,
    poolName: POOL_LABEL[type] || `${data.typeName}跃迁`,
    tabs: tabs.map(t => ({ name: POOL_LABEL[t] || t, active: t === type })),
    recent5: fiveLog.slice(0, 15),
    recentMore: Math.max(0, fiveLog.length - 15),
    poolCards,
    list: list.slice(0, 13),
    listMore: Math.max(0, list.length - 13),
    stats: data.line || [],
    allNum: data.allNum,
    fiveNum: fiveLog.length,
    firstTime: data.firstTime,
    lastTime: data.lastTime,
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
        { reg: '^\\s*#?星铁(?:全部)?抽卡记录\\s*$', fnc: 'viewLog' },
      ],
    })
  }

  /** *抽卡记录 —— 数据已经并进 genshin 的库，直接借它的模板出图 */
  async viewLog() {
    this.e.isSr = true
    this.e.isAll = /全部/.test(this.e.msg)
    // 出图走 e.runtime.render；正常事件链上一定有，这里只是兜住被别处转发来的 e
    if (!this.e.runtime?.render) await ensureRuntime(this.e)

    // *全部记录 保持原样交给 genshin 的模板，只有 *抽卡记录 走小程序风格的新图
    if (this.e.isAll) {
      const { default: GachaLog } = await import('../../genshin/model/gachaLog.js')
      const data = await new GachaLog(this.e).getLogData()
      if (!data) return true
      const img = await this.renderImg('genshin', 'html/gacha/gacha-all-log', data, {
        retType: 'base64',
      })
      if (img) await this.reply(img)
      return true
    }
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
    const renderScale = getRenderScaleStyle(config(), 1.4)
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






