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
import { config, pluginDir, getRenderScaleStyle, loadStokenYaml } from '../utils/pluginConfig.js'
import { extractRenderBuffer, toWebp } from '../utils/renderImage.js'
import { parseImportFile } from '../utils/gachaImport.js'
import { analyse, buildLine, getIcon, poolMax } from '../utils/gachaStat.js'

const BADGE_LOGIN = 'https://api-takumi.mihoyo.com/common/badge/v1/login/account'
const SR_ROLES = 'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie?game_biz=hkrpg_cn'
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

function savePoolCache(uid, type, cards, pity) {
  const all = readPoolCache()
  const key = String(uid)
  all[key] = all[key] || {}
  const prev = all[key][String(type)] || {}
  all[key][String(type)] = {
    at: Date.now(),
    cards: cards || prev.cards || [],
    // 接口给的当前垫抽。本地记录里的四星三星是缺的，出图时靠它兜底
    pity: pity === undefined ? prev.pity || 0 : Number(pity) || 0,
  }
  try {
    fs.mkdirSync(path.dirname(POOL_CACHE), { recursive: true })
    fs.writeFileSync(POOL_CACHE, JSON.stringify(all, null, 1))
  } catch (err) {
    logger?.debug?.(`[xhh-TL][抽卡记录] 卡池缓存写入失败：${err.message}`)
  }
}

/** 取某池缓存下来的接口垫抽数 */
function cachedPity(uid, type) {
  return Number(readPoolCache()[String(uid)]?.[String(type)]?.pity) || 0
}

/**
 * 「期次编号 → 该期 UP 名单」，汇总所有账号缓存下来的 pool_stat。
 * 卡池期次是全服一样的，所以谁更新过都能给别人用；这份映射比手工维护的
 * UP 期间表准，判歪时优先走它（见 gachaStat 的 isUpRole）
 */
function upMapFromCache() {
  const map = new Map()
  const all = readPoolCache()
  for (const byType of Object.values(all)) {
    for (const entry of Object.values(byType || {})) {
      for (const c of entry?.cards || []) {
        const gid = String(c.gacha_id || '')
        const name = c.up_item?.name || ''
        if (!gid || !name) continue
        const arr = map.get(gid) || []
        if (!arr.includes(name)) arr.push(name)
        map.set(gid, arr)
      }
    }
  }
  return map
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
      // 取 set-cookie 三条路都要留：node-fetch v2/v3 走 headers.raw()（插件自带 v3，有 raw）；
      // 解析到 undici / 原生 fetch 时只有 getSetCookie()；两个都没有就退回 headers.get()，
      // 那会把多条挤成一条，下面按 key= 边界再切开。
      // 注意别拿「在插件目录外复制源码跑」的结果推断这里：那样解析到的是宿主的 undici 垫片
      if (typeof res.headers.raw === 'function') {
        setCookie = res.headers.raw()['set-cookie'] || []
      } else if (typeof res.headers.getSetCookie === 'function') {
        setCookie = res.headers.getSetCookie() || []
      } else {
        const merged = res.headers.get('set-cookie')
        if (merged) setCookie = [merged]
      }
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
    // -1002 米游社原话是「角色不存在或等级不符」，实测它同时对应「UID 不在本账号下」
    // 和「region 传错」两种，跟等级无关；抛原文会让人以为是等级不够
    if (json?.retcode === -1002) {
      throw new Error(`米游社查不到 UID ${uid} 这个角色，确认下扫码登录的是这个号，或者 #刷新ck 后再试`)
    }
    throw new Error(`换取抽卡记录凭证失败：${json?.message || '接口无响应'}（${json?.retcode}）`)
  }
  const act = setCookie
    // 走 headers.get() 兜底时多条 cookie 挤在一条里，按「逗号后紧跟 key=」切回来
    // （Expires 里的逗号后面到分号前没有 =，不会被误切）
    .flatMap(c => String(c).split(/,(?=[^;,]+=)/))
    .map(c => c.split(';')[0].trim())
    .filter(c => /^[\w-]+=/.test(c) && !/^aliyungf_tc=/.test(c))
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
    // 接口直接给的「这一发花了多少抽」，出图时优先用它，不靠数占位
    xhh_pity: String(node.gacha_count || ''),
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

  // 清占位**之前**先量一下每个五星在本地的间隔（含占位）。老版本写进去的 mini 记录没存
  // xhh_pity，抽数全靠占位数体现；占位一清、接口这轮又没回这条五星（只给最近 12 个月），
  // 就再也算不回来了。这份快照是那种记录的兜底抽数
  // 口径要跟 analyse 一致：一条五星的抽数 = 它到**更旧**那条五星之间的记录数（含自己）
  const localGap = new Map()
  let seen = 0
  let prevFive = ''
  for (const r of local) {
    if (String(r.rank_type) === '5') {
      if (prevFive) localGap.set(prevFive, seen)
      prevFive = String(r.id)
      seen = 0
    }
    seen++
  }
  // 最旧那条五星：它之前的记录本来就不在本地（authkey 只给最近 6 个月），拿剩下的记录数兜底
  if (prevFive) localGap.set(prevFive, seen)

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
  let patched = 0

  // 完整逐抽来源（抽卡链接 / 导入）的 id，用来判断某段区间里已经有多少条真实记录了。
  // 不能只比「最大 id」——真实记录只覆盖最近几个月时，更早的五星区间其实是空的，
  // 拿最大 id 一比会全判成「已有记录」，那些五星的抽数就会缩成 1。
  // 也不能只判「有没有」：authkey 只给最近 6 个月，真实记录段最早那一批本身是被官方截断的，
  // 跨在边界上的那个五星区间里会有几条真实记录、但离它实际花的抽数差一大截（实测 76 抽显示成 10）
  const fullIds = real
    .filter(r => r.xhh_src !== 'mini' && !r.xhh_fid)
    .map(r => big(r.id))
    .sort((a, b) => (a > b ? 1 : a < b ? -1 : 0))
  const countFullIn = (lo, hi) => fullIds.reduce((n, id) => (id > lo && id < hi ? n + 1 : n), 0)

  /**
   * 给某个五星补它之前的垫抽占位。anchorId 必须是这条五星在**本地**的 id：
   * 两套 id 后 9 位各编各的，拿接口 id 当区间边界会把同批次的真实记录数错
   */
  const fillGap = ({ name, count, anchorId, prevId, gachaId, time }) => {
    const gap = Number(count) - 1
    if (gap <= 0) return
    // 区间里已有的真实逐抽记录要抵扣掉，否则同一抽被算两遍
    const need = gap - countFullIn(prevId, anchorId)
    if (need <= 0) {
      notes.push(`${name}(${count}抽) 的区间已有完整记录，未补占位`)
      return
    }
    const phs = buildPlaceholders(uid, type, anchorId, prevId, need, usedIds, time, gachaId)
    added.push(...phs)
    addedPh += phs.length
    if (phs.length < need) notes.push(`${name} 的占位只补到 ${phs.length}/${need} 条`)
  }

  // 先把接口五星逐条对上本地记录，拿到每条在本地的锚点 id；
  // 占位要在第二轮才补——补某条五星的占位得先知道更旧那条落在本地哪个 id 上
  const anchors = stars.map(s => {
    const hit = buckets.get(dupKey(s.item.item_id, s.id))?.shift()
    return { hit, anchorId: hit ? big(hit.id) : big(s.id) }
  })

  const claimed = new Set(anchors.map(a => a.hit).filter(Boolean))
  // 每条五星最终认定的抽数，占位补齐要按它算（跟出图用的 xhh_pity 必须同一口径）
  const finalCount = new Array(stars.length)
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i]
    const { hit } = anchors[i]
    const gachaId = poolStat.byUpItem.get(String(s.item.item_id)) || ''
    finalCount[i] = Number(s.gacha_count) || 0
    if (hit) {
      skipped++
      // 抽数取「接口值」和「本地间隔」更大的那个 —— 两个来源各有各的缺口，谁都不能无条件盖对方：
      //   接口（five_star_list）：五星历史全（约 12 个月），但不含四星/逐抽
      //   authkey（getGachaLog）：逐抽全，但只给最近 6 个月，跨在截断边界上的五星间隔会偏小
      // 取大的一方等价于「保留更全的那份」，偏小的那份一定是被截断的
      const localNum = Number(localGap.get(String(hit.id))) || 0
      finalCount[i] = Math.max(Number(s.gacha_count) || 0, localNum)
      const fuller = String(finalCount[i])
      if (String(hit.xhh_pity || '') !== fuller) {
        hit.xhh_pity = fuller
        patched++
      }
    } else {
      added.push(toRecord(uid, type, s, gachaId))
      usedIds.add(String(s.id))
      added5++
    }
  }

  // 占位每轮全清重建，但接口只回最近 12 个月的五星 —— 只按接口那份重建的话，
  // 滑出窗口的老五星占位就没人管了，抽数会缩成 1。本地存过官方抽数（xhh_pity）的
  // 五星一并纳入锚点，按 id 降序连成一条链，各自补自己那段
  const legacy = real
    .filter(r => String(r.rank_type) === '5' && !claimed.has(r))
    // 只管靠占位撑抽数的那些（小程序来源）：真实逐抽记录不需要占位，
    // 它们的间隔本来就是真的，countFullIn 也会把区间里的真实记录抵扣掉
    .filter(r => r.xhh_src === 'mini' || Number(r.xhh_pity) > 0)
    .map(r => ({
      name: r.name,
      // 同样取更全的一方：存过的官方抽数 vs 本地间隔
      count: Math.max(Number(r.xhh_pity) || 0, Number(localGap.get(String(r.id))) || 0),
      anchorId: big(r.id),
      gachaId: r.gacha_id || '',
      time: r.time,
    }))
  const chain = [
    ...stars.map((s, i) => ({
      name: s.item.name,
      count: finalCount[i],
      anchorId: anchors[i].anchorId,
      gachaId: poolStat.byUpItem.get(String(s.item.item_id)) || '',
      time: idToTime(s.id),
    })),
    ...legacy,
  ].sort((a, b) => (b.anchorId > a.anchorId ? 1 : b.anchorId < a.anchorId ? -1 : 0))
  for (let i = 0; i < chain.length; i++) {
    fillGap({ ...chain[i], prevId: chain[i + 1]?.anchorId ?? 0n })
  }

  // 当前垫抽：最新五星之后又抽了 pity 抽还没出货
  if (remote.pity > 0) {
    const lastStarId = chain[0]?.anchorId ?? 0n
    const nowId = BigInt(Math.floor(Date.now() / 1000)) * 1000000000n
    const need = remote.pity - countFullIn(lastStarId, nowId)
    if (need <= 0) {
      notes.push(`当前垫抽 ${remote.pity} 抽的区间已有完整记录，未补占位`)
    } else {
      const phs = buildPlaceholders(
        uid,
        type,
        nowId,
        lastStarId,
        need,
        usedIds,
        moment().format('YYYY-MM-DD HH:mm:ss'),
        '',
      )
      added.push(...phs)
      addedPh += phs.length
    }
  }

  const changed = added.length > 0 || patched > 0 || local.length !== real.length
  if (changed) {
    const merged = [...added, ...real].sort((a, b) => {
      const x = big(a.id)
      const y = big(b.id)
      return y > x ? 1 : y < x ? -1 : 0
    })
    writeLocal(userId, uid, type, merged)
    return { added5, addedPh, skipped, patched, notes, changed, total: merged.length }
  }
  return { added5, addedPh, skipped, patched, notes, changed, total: local.length }
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
    const dir = path.join(SR_JSON_DIR, String(e.user_id))
    const subs = fs.readdirSync(dir).filter(d => /^\d+$/.test(d))
    if (subs.length === 1) return { uid: subs[0], user: null }
    // 多个 uid 目录时取最近写过的那个：刚更新完的号就是用户正在看的号
    if (subs.length > 1) {
      const newest = subs
        .map(d => ({ d, at: mtimeOf(path.join(dir, d)) }))
        .sort((a, b) => b.at - a.at)[0]
      if (newest?.at) return { uid: newest.d, user: null }
    }
  } catch (_) {}
  return { uid: '', user: null }
}

/**
 * 本地是否已经有这个号的抽卡记录 —— 用来判断这次是不是「第一次」更新/导入。
 * 只看文件大小不解析内容：空池写进去是 `[]`（2 字节），比它大就算有记录
 */
function hasLocalRecords(userId, uid) {
  if (!uid) return false
  try {
    const dir = path.join(SR_JSON_DIR, String(userId), String(uid))
    return fs
      .readdirSync(dir)
      .some(f => f.endsWith('.json') && fs.statSync(path.join(dir, f)).size > 2)
  } catch (_) {
    return false
  }
}

/** 目录下最新一个 json 的修改时间（目录自身的 mtime 不随文件内容改变而更新） */
function mtimeOf(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .reduce((m, f) => Math.max(m, fs.statSync(path.join(dir, f)).mtimeMs), 0)
  } catch (_) {
    return 0
  }
}

/**
 * 用户真正绑好的星铁 UID 列表。只认绑定，不看本地记录目录 ——
 * 链接是别人的号也能拉出记录来，所以收链接前必须拿这个把关
 */
async function boundSrUids(e) {
  try {
    const user = await createUser(e.user_id, e)
    const list = user?.getUidList?.('sr') || []
    return list.map(x => String(x?.uid ?? x)).filter(u => /^\d+$/.test(u))
  } catch (err) {
    logger?.debug?.(`[xhh-TL][抽卡记录] 读绑定列表失败：${err.message}`)
    return []
  }
}

/**
 * 拉全量之前先探一页，问出这条链接属于哪个 UID。
 * authkey 链接本身不带 UID，只能从接口响应里取；角色池最可能有记录，常驻和光锥兜底
 */
async function probeLinkUid(params) {
  for (const pool of ['11', '1', '12']) {
    const data = await fetchGachaPageRetry(params, pool, '0')
    if (data.region && !params.region) params.region = data.region
    const uid = data.list?.[0]?.uid
    // 探完紧接着就是几十页的正式拉取，这里也要留间隔，别自己把限流踩出来
    await sleep(700)
    if (uid) return String(uid)
  }
  return ''
}

/**
 * 星铁 region 按 UID 号段推断 —— 只在拿不到米游社角色列表时兜底。
 * 取「除末 8 位以外的前缀」而不是首位：亚服有 18 开头的 10 位 UID，
 * 只看首位会把它判成国服。号段映射跟 genshin 插件 model/gachaLog.js 的 getServer 对齐
 * （欧服是 prod_official_euro，写成 eur 会被米游社判角色不存在）。
 * yaml 里的 region 常常是原神的（cn_gf01），直接拿来用同样会被判 -1002。
 */
function guessSrRegion(uid) {
  switch (String(uid).slice(0, -8)) {
    case '5':
      return 'prod_qd_cn'
    case '6':
      return 'prod_official_usa'
    case '7':
      return 'prod_official_euro'
    case '8':
    case '18':
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
      signal: AbortSignal.timeout(15000),
    },
  )
  const json = await res.json().catch(() => null)
  const ct = json?.data?.cookie_token
  if (!ct) throw new Error(`换取 cookie_token 失败：${json?.message || '无响应'}（${json?.retcode}）`)
  return ct
}

/**
 * 该米游社账号名下的星铁角色，返回 [{uid, region, nickname, level}]；接口没给就返回 null。
 * 有了它 region 就不用按号段猜（B 服 / 亚服 / 欧服全靠猜很容易错），
 * 也能在换凭证之前判出「这个 UID 不属于这个账号」——
 * 否则只能等米游社回 -1002，而那个码同时对应「区服错」和「角色不属于本账号」，分不清。
 */
async function fetchSrRoles(cookie) {
  try {
    const res = await fetch(SR_ROLES, {
      headers: { 'User-Agent': UA, Cookie: cookie, Referer: 'https://app.mihoyo.com' },
      signal: AbortSignal.timeout(15000),
    })
    const json = await res.json().catch(() => null)
    if (json?.retcode !== 0) {
      logger?.debug?.(`[xhh-TL][抽卡记录] 取角色列表失败：${json?.message}（${json?.retcode}）`)
      return null
    }
    return (json?.data?.list || [])
      .map(r => ({
        uid: String(r.game_uid || ''),
        region: String(r.region || ''),
        nickname: r.nickname || '',
        level: r.level,
      }))
      .filter(r => r.uid)
  } catch (err) {
    logger?.debug?.(`[xhh-TL][抽卡记录] 取角色列表异常：${err.message}`)
    return null
  }
}

/** 一条 stoken 素材 → 含 cookie_token 的米游社 cookie；换不出来返回空串 */
async function cookieFromEntry({ stuid, stoken, mid, raw }) {
  if (stuid && stoken) {
    try {
      return `account_id=${stuid};cookie_token=${await fetchCookieToken(stuid, stoken, mid)}`
    } catch (err) {
      logger?.debug?.(`[xhh-TL][抽卡记录] passport 换 cookie_token 失败：${err.message}`)
    }
  }
  if (raw) {
    // 兜底：插件既有的换取逻辑，或本身就是含 cookie_token 的完整 ck
    const fallback = await stokenToCookie(typeof raw === 'string' ? { ck_stoken: raw } : raw)
    if (/cookie_token=/.test(fallback || '')) return fallback
  }
  return ''
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

  // 候选凭证：getstoken 挑的那份排头，后面补上同 QQ 名下别的米游社账号。
  // 多号用户身上 getstoken 可能挑到不是这个 UID 属主的那份（体力查询无所谓，
  // 抽卡记录这一步会被米游社判成角色不存在），所以按「名下有没有这个 UID」逐个试。
  const cands = [
    {
      stuid:
        cookiePart(src, 'stuid') ||
        cookiePart(src, 'ltuid') ||
        cookiePart(src, 'account_id') ||
        yamlEntry.stuid ||
        '',
      stoken: cookiePart(src, 'stoken') || yamlEntry.stoken || '',
      mid: cookiePart(src, 'mid') || yamlEntry.mid || '',
      raw,
    },
  ]
  for (const entry of Object.values(loadStokenYaml(e.user_id) || {})) {
    if (!entry?.stuid || !entry?.stoken) continue
    if (cands.some(c => String(c.stuid) === String(entry.stuid))) continue
    cands.push({ stuid: String(entry.stuid), stoken: entry.stoken, mid: entry.mid || '', raw: null })
  }

  let firstCookie = ''
  const seen = [] // 这些凭证能查到的 UID，用来在对不上时举例
  for (const c of cands) {
    const cookie = await cookieFromEntry(c)
    if (!cookie) {
      logger?.debug?.(`[xhh-TL][抽卡记录] 凭证 ${c.stuid} 换不出 cookie_token，跳过`)
      continue
    }
    if (!firstCookie) firstCookie = cookie
    const roles = await fetchSrRoles(cookie)
    if (!roles) continue // 接口没响应，留给下面的号段兜底
    const hit = roles.find(r => r.uid === String(uid))
    logger?.debug?.(
      `[xhh-TL][抽卡记录] 凭证 ${c.stuid} 名下星铁角色 ${roles.map(r => r.uid).join('/') || '无'}，找 ${uid} ${hit ? '命中' : '没命中'}`
    )
    if (hit) return { cookie, region: hit.region || guessSrRegion(uid) }
    seen.push(...roles.map(r => r.uid))
  }
  if (!firstCookie) {
    throw new Error('拿不到米游社凭证，stoken 可能已失效，重新扫码登录一次试试')
  }
  // 凭证是好的，但名下确实没有这个 UID —— 换过号或者绑错号才会这样，直接说清楚
  if (seen.length) {
    const list = [...new Set(seen)].slice(0, 3).join('、')
    throw new Error(`UID ${uid} 不在你登录的米游社账号下（这个号能查的是 ${list}），换成对应的号扫码登录再试`)
  }
  // 角色列表接口没给结果：退回老办法，region 按绑定信息 / 号段推断，成不成交给下一步
  const candidates = [
    (user?.getUidList?.('sr') || []).find(x => String(x.uid) === String(uid))?.region,
    yamlEntry.sr_region,
    String(uid) === String(yamlEntry.uid) ? yamlEntry.region : '',
  ]
  const region = candidates.find(r => /^prod_/.test(String(r || ''))) || guessSrRegion(uid)
  return { cookie: firstCookie, region }
}


/** 数字 gacha_type → 小程序里的池名 */
const POOL_LABEL = Object.fromEntries(POOLS.map(p => [p.type, p.name]))
POOL_LABEL['1'] = '常驻跃迁'

/**
 * 从消息里的文件段拿下载直链。
 * 各适配器字段不一样：icqq 是 `fid` + `getFileUrl`，OneBot v11 的群文件上传事件
 * 只给 `{id, name, size, busid}`，得走 get_group_file_url 才有 url
 */
async function fileUrlFromSeg(e, seg) {
  if (/^https?:\/\//.test(seg.url || '')) return seg.url
  const fid = seg.fid || seg.id || seg.file_id
  if (!fid) return ''
  const tries = [
    () => e.group?.getFileUrl?.(fid),
    () => e.friend?.getFileUrl?.(fid),
    () => e.group?.fs?.download?.(fid, seg.busid),
    () => e.friend?.fs?.download?.(fid, seg.busid),
    () =>
      e.group_id &&
      e.bot?.sendApi?.('get_group_file_url', {
        group_id: e.group_id,
        file_id: fid,
        busid: seg.busid,
      }),
    () => e.bot?.sendApi?.('get_private_file_url', { user_id: e.user_id, file_id: fid }),
  ]
  for (const fn of tries) {
    try {
      const r = await fn()
      const url = typeof r === 'string' ? r : r?.url || r?.data?.url || ''
      if (/^https?:\/\//.test(url)) return url
    } catch (err) {
      logger?.debug?.(`[xhh-TL][抽卡记录] 取文件直链失败：${err.message}`)
    }
  }
  return ''
}

/** 从消息里的文件段或链接取出导入文件 */
async function fetchImportFile(e) {
  let url = ''
  let name = ''
  const seg =
    e.file ||
    (Array.isArray(e.message) ? e.message.find(m => m?.type === 'file') : null) ||
    null
  if (seg) {
    name = seg.name || seg.file_name || seg.file || ''
    url = await fileUrlFromSeg(e, seg)
    if (!url) throw new Error('拿不到这个文件的下载地址，可以改成私聊发，或者把文件直链贴在指令后面')
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

  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(60000),
  })
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

    // 判重只看非 mini 的记录：mini 五星本来就是等着被真实记录顶替的（见下面 dropMini），
    // 让它参与判重的话，同一发的真实记录会被当成重复挡在门外，mini 就永远顶不掉了。
    // mini 的 time 是 id 前 10 位（批次水位，通常是整分钟）反解出来的，跟官方 time 多数差几十秒，
    // 所以这个坑平时不发作——碰巧相等时才会漏，属于藏得比较深的那种
    const localNonMini = localReal.filter(r => r.xhh_src !== 'mini')
    const ids = new Set(localNonMini.map(r => String(r.id)))
    const keyOf = r => `${r.time}|${r.name}`
    const keyCount = new Map()
    for (const r of localNonMini) keyCount.set(keyOf(r), (keyCount.get(keyOf(r)) || 0) + 1)

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
    // 顶替之前先把 mini 记录上的官方抽数（xhh_pity）交给接班的真实记录：
    // authkey 只给最近 6 个月，跨在截断边界上的那个五星本地间隔算不准，
    // 丢了这个字段就只能等下一次 *更新抽卡记录 才补回来
    const addFive = new Map()
    for (const r of add) {
      if (String(r.rank_type) !== '5') continue
      const bk = `b:${r.item_id}@${String(r.id).slice(0, 10)}`
      const dk = r.time ? `d:${r.item_id}@${String(r.time).slice(0, 10)}` : ''
      if (!addFive.has(bk)) addFive.set(bk, r)
      if (dk && !addFive.has(dk)) addFive.set(dk, r)
    }
    const kept = localReal.filter(r => {
      if (r.xhh_src !== 'mini') return true
      // 小程序的 id 与游戏内导出前 10 位（批次时间戳）一致，Excel 的伪 id 只能按日期对
      const bk = `b:${r.item_id}@${String(r.id).slice(0, 10)}`
      const dk = r.time ? `d:${r.item_id}@${String(r.time).slice(0, 10)}` : ''
      const covered = coverKeys.has(bk) || (dk && coverKeys.has(dk))
      if (covered) {
        const heir = addFive.get(bk) || (dk ? addFive.get(dk) : null)
        if (heir && r.xhh_pity && !heir.xhh_pity) heir.xhh_pity = String(r.xhh_pity)
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

/**
 * 惰性共享抽卡 cookie：*全部记录 要刷六个池的垫抽，
 * 原来每池都重新 prepareCookie + badgeLogin，首次出图会连打十几个米游社请求。
 * 包一层只在真的需要刷新时登录一次，之后各池复用同一个 promise
 */
function lazyGachaCookie(e, uid) {
  let pending = null
  return () => {
    if (!pending) {
      pending = (async () => {
        const { cookie, region } = await prepareCookie(e, uid, null)
        return badgeLogin(cookie, uid, region)
      })()
    }
    return pending
  }
}

/** 出图前顺手把当前池的垫抽刷新一下（缓存超过 10 分钟才动，失败就沿用旧值） */
async function refreshPity(e, uid, type, getCookie) {
  const pool = POOLS.find(p => p.type === String(type))
  if (!pool) return // 常驻池接口不给，本地算得出来
  const entry = readPoolCache()[String(uid)]?.[String(type)]
  if (entry?.at && Date.now() - entry.at < 10 * 60 * 1000) return
  try {
    const gachaCookie = await (getCookie || lazyGachaCookie(e, uid))()
    const q = new URLSearchParams({ gacha_type: pool.key, version_id: '0', max_id: '0' })
    const { json } = await api(`${GACHA_BASE}/five_star_list?${q}`, { cookie: gachaCookie })
    if (json?.retcode !== 0) return
    const first = (json.data?.list || [])[0]
    // 首条 item=null 的就是当前垫抽
    const pity = first && !first.item ? Number(first.gacha_count) || 0 : 0
    savePoolCache(uid, type, undefined, pity)
  } catch (err) {
    logger?.debug?.(`[xhh-TL][抽卡记录] 刷新垫抽失败，用缓存值：${err.message}`)
  }
}

/** 组装小程序风格出图所需数据。只读本地记录自己算，不依赖 genshin 插件 */
async function buildViewData(e, uid) {
  if (!uid) return null
  const type = parsePoolType(e.msg)
  const list = readLocal(e.user_id, uid, type)
  if (!list.length) return null

  await refreshPity(e, uid, type)
  const entry = readPoolCache()[String(uid)]?.[String(type)]
  const stat = analyse(list, type, Number(entry?.pity) || 0, upMapFromCache())
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
    // 显示的是数据抓取时刻，不是出图时刻，免得让人以为垫抽是刚拉的
    updatedAt: entry?.at
      ? moment(entry.at).format('MM-DD HH:mm')
      : (stat.lastTime || '').slice(5, 16) || moment().format('MM-DD HH:mm'),
  }
}

/** 全部记录：每个有数据的池各出一块，池内不铺条形列表，只放统计与五星头像 */
async function buildAllViewData(e, uid) {
  if (!uid) return null
  const pools = []
  let newestAt = 0
  // 六个池共用一份映射，别每池都去读一次缓存文件
  const upMap = upMapFromCache()
  // 也共用一次登录：真有池要刷垫抽时才会去换凭证
  const getCookie = lazyGachaCookie(e, uid)
  for (const type of ['11', '12', '21', '22', '1', '2']) {
    const list = readLocal(e.user_id, uid, type)
    if (!list.length) continue
    await refreshPity(e, uid, type, getCookie)
    const entry = readPoolCache()[String(uid)]?.[String(type)]
    if (entry?.at > newestAt) newestAt = entry.at
    const stat = analyse(list, type, Number(entry?.pity) || 0, upMap)
    const five = []
    for (const it of stat.fiveLog) {
      five.push({
        name: it.name,
        num: it.num,
        isUp: it.isUp,
        icon: await getIcon(it.name, it.item_type),
      })
    }
    pools.push({
      name: POOL_LABEL[type] || `${type} 号池`,
      allNum: stat.allNum,
      fiveNum: stat.fiveNum,
      pity: stat.noFiveNum,
      max: poolMax(type),
      stats: buildLine(stat, type),
      five,
      firstTime: stat.firstTime,
      lastTime: stat.lastTime,
    })
  }
  if (!pools.length) return null

  const total = pools.reduce((n, p) => n + p.allNum, 0)
  const totalFive = pools.reduce((n, p) => n + p.fiveNum, 0)
  const ys = total * 160
  return {
    uid: String(uid),
    pools,
    total,
    totalFive,
    totalYs: ys >= 10000 ? `${(ys / 10000).toFixed(2)}w` : String(ys),
    avg: totalFive ? Math.round(total / totalFive) : 0,
    updatedAt: moment(newestAt || Date.now()).format('MM-DD HH:mm'),
  }
}

/** 游戏内抽卡链接（authkey）拉取：国服 / 国际服两套域名 */
const LOG_HOST_CN = 'https://public-operation-hkrpg.mihoyo.com'
const LOG_HOST_OS = 'https://public-operation-hkrpg-sg.hoyoverse.com'

/** 从消息里抠出抽卡链接的参数；不是星铁链接返回 null */
function parseGachaUrl(msg = '') {
  let url = String(msg).replace(/〈=/g, '&').trim()
  if (!/authkey=/.test(url)) return null
  if (url.includes('getGachaLog?')) url = url.split('getGachaLog?')[1]
  else if (url.includes('index.html?')) url = url.split('index.html?')[1]
  else if (url.includes('?')) url = url.slice(url.indexOf('?') + 1)

  const params = Object.fromEntries(new URLSearchParams(url))
  if (!params.authkey) return null
  // 链接尾部常带 #/log 之类的锚点
  params.authkey = params.authkey.replace(/#\/log|#\/|#$/g, '')
  const biz = params.game_biz || ''
  const isSr = /hkrpg/.test(biz) || /hkrpg/.test(String(msg))
  if (!isSr) return null
  return params
}

async function fetchGachaPage(params, gachaType, endId) {
  const cn = ['prod_gf_cn', 'prod_qd_cn'].includes(params.region || 'prod_gf_cn')
  // 联动池是另一个端点
  const ep = ['21', '22'].includes(String(gachaType)) ? 'getLdGachaLog' : 'getGachaLog'
  const q = new URLSearchParams({
    authkey_ver: params.authkey_ver || '1',
    sign_type: params.sign_type || '2',
    auth_appid: params.auth_appid || 'webview_gacha',
    lang: 'zh-cn',
    game_biz: params.game_biz || 'hkrpg_cn',
    region: params.region || 'prod_gf_cn',
    authkey: params.authkey,
    gacha_type: String(gachaType),
    page: '1',
    size: '20',
    end_id: String(endId || 0),
  })
  let res
  try {
    res = await fetch(`${cn ? LOG_HOST_CN : LOG_HOST_OS}/common/gacha_record/api/${ep}?${q}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(20000),
    })
  } catch (err) {
    // 请求层面的失败（超时、断网）：原文是英文的，只进日志
    logger?.warn?.(
      `[xhh-TL][抽卡记录] 池 ${gachaType} end_id=${endId} 请求失败：${err.name} ${err.message}`,
    )
    const wrapped = new Error(
      /Abort|Timeout/i.test(err.name) ? '接口一直没响应，稍后再试' : '连不上米哈游接口，稍后再试',
    )
    // 网络抖动值得重试，交给 fetchGachaPageRetry
    wrapped.retriable = true
    throw wrapped
  }
  if (!res.ok) throw new Error(`接口 HTTP ${res.status}`)
  const json = await res.json().catch(() => null)
  if (!json) throw new Error('接口没返回 JSON')
  if (json.retcode !== 0) {
    // 细节只进日志，抛给用户的是人话
    logger?.warn?.(
      `[xhh-TL][抽卡记录] 池 ${gachaType} end_id=${endId} 接口返回 ` +
        `${json.retcode}：${json.message || ''}`,
    )
    let err
    if ([-100, -101, -111].includes(json.retcode)) {
      err = new Error('链接大概过期了，去游戏里重新复制一次')
    } else if (json.retcode === -110) {
      // 官方限流（visit too frequently），等一会儿重试就好，不是链接的问题
      err = new Error('米哈游那边限流了，稍等一会儿再试')
      err.retriable = true
    } else {
      err = new Error('米哈游接口没给记录，稍后再试一次')
    }
    throw err
  }
  return json.data || {}
}

/** 限流或网络抖动时退避重试；退避时长逐次加长，全失败才把错抛出去 */
const RETRY_WAITS = [5000, 15000, 30000, 60000]

async function fetchGachaPageRetry(params, gachaType, endId) {
  for (let i = 0; ; i++) {
    try {
      return await fetchGachaPage(params, gachaType, endId)
    } catch (err) {
      if (!err.retriable || i >= RETRY_WAITS.length) throw err
      logger?.info?.(
        `[xhh-TL][抽卡记录] 池 ${gachaType} 拉取受阻（${err.message}），` +
          `等 ${RETRY_WAITS[i] / 1000}s 后重试（第 ${i + 1}/${RETRY_WAITS.length} 次）`,
      )
      await sleep(RETRY_WAITS[i])
    }
  }
}

/**
 * 按池分页拉取。默认增量：翻到本地已有的原生记录就停，
 * 所以第二次用链接更新会快很多（full=true 时拉全量）
 */
async function fetchAllByAuthkey(params, userId, { full = false, onPool } = {}) {
  const records = []
  let uid = ''
  let stopId = new Map()
  try {
    for (const pool of [...POOLS.map(p => p.type), '1']) {
      let endId = '0'
      let got = 0
      let reachedOld = false
      // 页数上限按最重的号留余量：实测重氪角色池能到 2500+ 条（125 页），
      // 原来卡在 120 页会把最早的记录悄悄截掉
      for (let i = 0; i < 400 && !reachedOld; i++) {
        const data = await fetchGachaPageRetry(params, pool, endId)
        if (data.region && !params.region) params.region = data.region
        const list = data.list || []

        // 第一页拿到 uid 后才能读本地，算出这个池的增量下界
        if (!uid && list[0]?.uid) uid = String(list[0].uid)
        if (!full && uid && !stopId.has(pool)) {
          const local = readLocal(userId, uid, pool)
          stopId.set(
            pool,
            local
              .filter(r => !r.xhh_src && !r.xhh_fid)
              .reduce((m, r) => (big(r.id) > m ? big(r.id) : m), 0n),
          )
        }
        const floor = stopId.get(pool) || 0n

        for (const r of list) {
          if (!full && floor > 0n && big(r.id) <= floor) {
            reachedOld = true
            break
          }
          records.push({
            uid: String(r.uid || uid || ''),
            gacha_id: String(r.gacha_id || ''),
            gacha_type: String(r.gacha_type || pool),
            item_id: String(r.item_id || ''),
            count: String(r.count || '1'),
            time: String(r.time || ''),
            name: String(r.name || ''),
            lang: String(r.lang || 'zh-cn'),
            item_type: String(r.item_type || ''),
            rank_type: String(r.rank_type || ''),
            id: String(r.id || ''),
          })
          got++
        }
        if (list.length < 20) break
        endId = list[list.length - 1].id
        await sleep(700)
      }
      onPool?.(pool, got)
      await sleep(500)
    }
  } catch (err) {
    // 半路失败也别浪费已经翻到的页：挂在错误上，让上层先落盘
    err.partial = { records, uid }
    throw err
  }
  return { records, uid }
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
        // 抽卡链接：只吃星铁的（含 hkrpg），原神的交回 genshin
        { reg: 'authkey=', fnc: 'logUrl' },
        { reg: '^\\s*#?星铁(?:[xX][hH][hH]|小火花)?(?:强制)?(?:更新|获取)抽卡记录\\s*$', fnc: 'updateLog' },
        {
          // 允许「*导入记录」后面直接跟文件直链，也支持只发指令+附件
          reg: '^\\s*#?星铁(?:强制)?导入(?:抽卡)?记录(?:json|excel|xlsx)?(?:\\s+\\S+)?\\s*$',
          fnc: 'importLog',
        },
        // 单个卡池走小程序风格出图；「全部记录」是同一套 UI 的总览版
        { reg: '^\\s*#?星铁全部(?:抽卡)?记录\\s*$', fnc: 'viewAll' },
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

  /** 用户发来游戏内抽卡链接：拉全量真实记录，合并后出新图 */
  async logUrl() {
    const params = parseGachaUrl(this.e.msg)
    // 不是星铁链接（大概率是原神的），返回 false 让 loader 继续找别的插件
    if (!params) return false

    this.e.isSr = true
    if (!this.e.runtime?.render) await ensureRuntime(this.e)
    const full = /全量|强制/.test(this.e.msg)
    const recall = this.e.isGroup ? '，记得把链接撤回哦' : ''

    // 只收已绑定那个号的链接：先查绑定（本地、不花请求），再探链接属于谁
    const bound = await boundSrUids(this.e)
    if (!bound.length) {
      await this.reply(
        `你还没绑定星铁 UID，先发【#星铁绑定uid+你的UID】绑好再来发链接哦${recall}`,
        false,
        { at: true },
      )
      return true
    }

    let linkUid = ''
    try {
      linkUid = await probeLinkUid(params)
    } catch (err) {
      logger?.error?.(`[xhh-TL][抽卡记录] 链接探测失败：${err.stack || err.message}`)
      await this.reply(`这条链接用不了：${err.message}${recall}`, false, { at: true })
      return true
    }
    if (!linkUid) {
      await this.reply(`这条链接里没查到抽卡记录${recall}`, false, { at: true })
      return true
    }
    if (!bound.includes(linkUid)) {
      logger?.info?.(
        `[xhh-TL][抽卡记录] ${this.e.user_id} 发来 ${linkUid} 的链接，已绑定 ${bound.join('、')}，拒收`,
      )
      await this.reply(
        `这条链接是 ${linkUid} 的，你绑定的是 ${bound.join('、')}，只收已绑定那个号的链接哦${recall}`,
        false,
        { at: true },
      )
      return true
    }

    await this.reply(
      `收到星铁抽卡链接，正在${full ? '全量' : '增量'}拉取记录，这一步比较慢…`,
      false,
      { at: true },
    )

    // 第一次导入（本地一条记录都没有）出总览图，之后照旧出单池图
    const first = !hasLocalRecords(this.e.user_id, linkUid)
    try {
      const perPool = []
      const { records } = await fetchAllByAuthkey(params, this.e.user_id, {
        full,
        onPool: (pool, got) => perPool.push(`${POOL_LABEL[pool] || pool} ${got}`),
      })
      const uid = linkUid
      if (!records.length) {
        await this.reply('拉完了，没有新记录', false, { at: true })
        await (first ? this.renderAll(uid) : this.renderMini(uid))
        return true
      }

      assignIds(records)
      const stat = mergeImport(this.e.user_id, uid, records)
      // 细节只进日志
      logger?.info?.(
        `[xhh-TL][抽卡记录] ${uid} 抽卡链接更新：新增 ${stat.added} 条` +
          `${stat.skipped ? `，已有 ${stat.skipped} 条` : ''}` +
          `${stat.dropMini ? `，替换小程序五星 ${stat.dropMini} 条` : ''}` +
          `${stat.dropPh ? `，清理占位 ${stat.dropPh} 条` : ''}` +
          `（${perPool.join('、')}）`,
      )
      await this.reply(`更新完成，新增 ${stat.added} 条${recall}`, false, { at: true })
      await (first ? this.renderAll(uid) : this.renderMini(uid))
    } catch (err) {
      logger?.error?.(`[xhh-TL][抽卡记录] 链接拉取失败：${err.stack || err.message}`)
      // 中断前已经翻到的记录先存下来，下次发链接会从这里接着拉
      let saved = 0
      const part = err.partial?.records || []
      if (part.length) {
        try {
          assignIds(part)
          saved = mergeImport(this.e.user_id, linkUid, part).added
          logger?.info?.(`[xhh-TL][抽卡记录] ${linkUid} 中断前已保存 ${saved} 条`)
        } catch (e2) {
          logger?.error?.(`[xhh-TL][抽卡记录] 部分记录保存失败：${e2.stack || e2.message}`)
        }
      }
      await this.reply(
        `没拉完就中断了：${err.message}` +
          (saved ? `。已经拿到的 ${saved} 条存好了，再发一次链接会接着拉` : ''),
        false,
        { at: true },
      )
    }
    return true
  }

  /** *全部记录 —— 同一套 UI 的总览版，每个池一块 */
  async viewAll() {
    this.e.isSr = true
    if (!this.e.runtime?.render) await ensureRuntime(this.e)
    return this.renderAll()
  }

  /** 总览出图。preferUid：刚更新/导入完的那个号，优先用它 */
  async renderAll(preferUid) {
    if (!this.e.runtime?.render) await ensureRuntime(this.e)
    const uid = String(preferUid || '') || (await resolveSrUid(this.e)).uid
    const data = await buildAllViewData(this.e, uid)
    if (!data) {
      await this.reply('还没有抽卡记录，先发 *更新抽卡记录 或 *导入记录', false, { at: true })
      return true
    }
    const tplFile = path.join(pluginDir, 'resources/gachaLog/allLog.html')
    const renderScale = getRenderScaleStyle(config(), 1.6)
    const res = await this.e.runtime.render('xhh-TL', 'gachaLog', data, {
      retType: 'base64',
      imgType: 'png',
      beforeRender: ({ data: d }) => ({
        ...d,
        imgType: 'png',
        sys: { scale: renderScale },
        ppath: '../../../../plugins/xhh-TL/resources/',
        tplFile,
        saveId: `gachaAll-${data.uid}`,
      }),
    })
    const img = await toWebp(extractRenderBuffer(res))
    if (!img) {
      await this.reply('总览出图失败，请稍后重试', false, { at: true })
      return true
    }
    await this.reply(segment.image(img))
    return true
  }

  /** 小程序「跃迁记录统计」风格出图。preferUid：刚更新/导入完的那个号，优先用它 */
  async renderMini(preferUid) {
    if (!this.e.runtime?.render) await ensureRuntime(this.e)
    const uid = String(preferUid || '') || (await resolveSrUid(this.e)).uid
    const data = await buildViewData(this.e, uid)
    if (!data) {
      await this.reply(
        uid ? '这个池还没有记录哦' : '还没有抽卡记录，先发 *更新抽卡记录 试试',
        false,
        { at: true },
      )
      return true
    }
    const tplFile = path.join(pluginDir, 'resources/gachaLog/gachaLog.html')
    // 1 倍图在手机上看着糊，这里放大渲染再压 jpeg
    const renderScale = getRenderScaleStyle(config(), 1.6)
    const res = await this.e.runtime.render('xhh-TL', 'gachaLog', data, {
      retType: 'base64',
      imgType: 'png',
      beforeRender: ({ data: d }) => ({
        ...d,
        imgType: 'png',
        sys: { scale: renderScale },
        ppath: '../../../../plugins/xhh-TL/resources/',
        tplFile,
        saveId: `gachaLog-${data.uid}-${data.poolName}`,
      }),
    })
    const img = await toWebp(extractRenderBuffer(res))
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
    // 第一次更新（本地一条记录都没有）出总览图，让人一眼看到所有池；之后照旧出单池图
    const first = !hasLocalRecords(this.e.user_id, uid)
    try {
      const { cookie, region } = await prepareCookie(this.e, uid, user)
      const gachaCookie = await badgeLogin(cookie, uid, region)
      // 更新完不发文案，统计只落日志，直接出图
      logger?.info?.(`[xhh-TL][抽卡记录] ${uid} ${await this.runUpdate(uid, gachaCookie)}`)
      await (first ? this.renderAll(uid) : this.renderMini(uid))
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
      await this.reply('文件里有你的记录，建议私聊导入；就要在群里发【*强制导入记录】', false, { at: true })
      return true
    }
    let file = null
    try {
      file = await fetchImportFile(this.e)
    } catch (err) {
      await this.reply(`取文件失败：${err.message}`, false, { at: true })
      return true
    }
    if (file) return this.doImport(file)

    // QQ 的文件是单独一条消息，指令里带不上，所以挂个上下文等下一条。
    // 本插件 priority 最低，上下文会抢在 genshin 的「请发送Json文件」之前
    this.setContext('importFile', false, 180, '导入超时已取消，重新发一次 *导入记录 就行')
    await this.reply('把文件发过来（json / Excel，三分钟内有效）', false, { at: true })
    return true
  }

  /** 等文件的上下文回调 */
  async importFile() {
    // 抽卡链接不是导入文件：交回 logUrl，别拿去当 json 下载
    if (/authkey=/.test(this.e.msg || '')) {
      this.finish('importFile', false)
      return 'continue'
    }
    // 不是文件也不是链接就别打断，交回给其它插件处理
    if (!this.e.file && !/https?:\/\/\S+/.test(this.e.msg || '')) return 'continue'
    this.finish('importFile', false)
    this.e.isSr = true
    let file = null
    try {
      file = await fetchImportFile(this.e)
    } catch (err) {
      await this.reply(`取文件失败：${err.message}`, false, { at: true })
      return true
    }
    if (!file) {
      await this.reply('没取到文件内容，重新发一次 *导入记录 试试', false, { at: true })
      return true
    }
    return this.doImport(file)
  }

  /** 真正的解析 + 合并 */
  async doImport(file) {
    const recall = this.e.isGroup ? '，记得把文件撤回哦' : ''
    // 跟收链接一个规矩：只收已绑定号的记录。没绑就不用解析文件了
    const bound = await boundSrUids(this.e)
    if (!bound.length) {
      await this.reply(
        `你还没绑定星铁 UID，先发【#星铁绑定uid+你的UID】绑好再来导入哦${recall}`,
        false,
        { at: true },
      )
      return true
    }

    try {
      const parsed = parseImportFile(file.buf, file.name)
      if (!parsed.records.length) throw new Error('文件里没有解析出任何记录')

      // 文件里出现过的 UID：UIGF v4 多包记在 uids，其余格式记在 uid，逐条记录也各自带
      const fileUids = [
        ...new Set(
          [...(parsed.uids || []), parsed.uid || '', ...parsed.records.map(r => r.uid || '')]
            .map(String)
            .filter(u => /^\d+$/.test(u)),
        ),
      ]
      // 绑定列表里主号排在最前，所以 find 天然优先主号
      const uid = fileUids.length ? bound.find(u => fileUids.includes(u)) : bound[0]
      if (!uid) {
        logger?.info?.(
          `[xhh-TL][抽卡记录] ${this.e.user_id} 导入的文件是 ${fileUids.join('、')} 的，` +
            `已绑定 ${bound.join('、')}，拒收`,
        )
        await this.reply(
          `这份文件是 ${fileUids.join('、')} 的，你绑定的是 ${bound.join('、')}，` +
            `只收已绑定那个号的记录哦${recall}`,
          false,
          { at: true },
        )
        return true
      }

      // 一份文件里混了几个号时，别的号的记录直接丢掉
      const records = fileUids.length
        ? parsed.records.filter(r => !r.uid || String(r.uid) === uid)
        : parsed.records
      const dropped = parsed.records.length - records.length
      if (!records.length) throw new Error(`文件里没有 ${uid} 的记录`)
      // Excel / csv 不带 UID，只能按主号存，多绑了几个号时得让用户知道存进了哪个
      const guessed = !fileUids.length && bound.length > 1 ? uid : ''

      await fillMeta(records)
      const faked = assignIds(records)
      // 第一次导入（本地一条记录都没有）出总览图，之后照旧出单池图
      const first = !hasLocalRecords(this.e.user_id, uid)
      const stat = mergeImport(this.e.user_id, uid, records)

      // 细节只进日志，群里只回一句
      logger?.info?.(
        `[xhh-TL][抽卡记录] ${uid} ${parsed.format} 导入：新增 ${stat.added} 条` +
          `${stat.skipped ? `，重复 ${stat.skipped} 条` : ''}` +
          `${stat.dropMini ? `，替换小程序五星 ${stat.dropMini} 条` : ''}` +
          `${stat.dropPh ? `，清理占位 ${stat.dropPh} 条` : ''}` +
          `${faked ? `，补序号 ${faked} 条` : ''}` +
          `${dropped ? `，丢弃别的号 ${dropped} 条` : ''}` +
          `${stat.pools.length ? `（${stat.pools.join('、')}）` : ''}`,
      )
      await this.reply(
        `导入完成，新增 ${stat.added} 条` +
          `${guessed ? `，存进了 ${guessed}` : ''}` +
          `${dropped ? `，另外 ${dropped} 条不是这个号的没要` : ''}` +
          recall,
        false,
        { at: true },
      )
      await (first ? this.renderAll(uid) : this.renderMini(uid))
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
    let patchedTotal = 0
    let remoteTotal = 0

    for (const pool of POOLS) {
      const remote = await fetchFiveStars(gachaCookie, pool.key)
      const poolStat = await fetchPoolStat(gachaCookie, pool.key)
      savePoolCache(uid, pool.type, poolStat.cards, remote.pity)
      const res = mergePool(userId, uid, pool.type, remote, poolStat)

      added5 += res.added5
      addedPh += res.addedPh
      skipped += res.skipped
      patchedTotal += res.patched || 0
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
      patchedTotal ? `补齐 ${patchedTotal} 条记录的接口抽数` : '',
      pityParts.length ? `垫抽 ${pityParts.join('/')}` : '',
      lines.join(' '),
      ...notes,
    ]
      .filter(Boolean)
      .join('；')
  }
}






