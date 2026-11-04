/**
 * 用户 UID / Cookie 绑定兼容层
 *
 * 目标：
 * - 不 import genshin 插件任何模块
 * - 在「有 genshin + Runtime」时行为与 NoteUser 一致
 * - 在「无 genshin」时仍可从 SQLite / stoken yaml / redis 解析绑定
 * - 与原版 miao / 本地 fork miao 均可共存（二者都通过 e.runtime 取 UID/CK）
 *
 * 数据源优先级：
 * 1. e.runtime.NoteUser（Runtime 注入，通常来自 genshin，但不在本插件 import）
 * 2. e.user（若已是 NoteUser 兼容实例）
 * 3. Yunzai SQLite：data/db/data.db 的 Users + MysUsers
 * 4. stoken yaml：xiaoyao-cvs-plugin / xhh / 本插件 data/Stoken
 * 5. redis 主 UID：Yz:genshin:mys:qq-uid / Yz:srJson:mys:qq-uid 等
 */

import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import { createRequire } from 'module'
import { getStokenCandidateFiles, loadStokenYaml } from './pluginConfig.js'

const require = createRequire(path.join(process.cwd(), 'package.json'))

const GAMES = ['gs', 'sr', 'zzz']

const GS_REGIONS = new Set(['cn_gf01', 'cn_qd01', 'os_usa', 'os_euro', 'os_asia', 'os_cht'])
const SR_REGIONS = new Set([
  'prod_gf_cn',
  'prod_qd_cn',
  'prod_official_usa',
  'prod_official_euro',
  'prod_official_asia',
  'prod_official_cht',
])
const BH3_REGIONS = new Set(['android01', 'ios01', 'pc01', 'bb01', 'yyb01', 'hun01', 'hun02'])

const GS_REGION_NAMES = /天空岛|世界树|America|Europe|Asia|TW|HK|MO/i
const SR_REGION_NAMES = /星穹|列车|Astral|Universe|America|Europe|Asia|TW|HK|MO/i
const ZZZ_REGION_NAMES = /绝区|绳网|Zenless|ZZZ/i

function gameKey(game = 'gs') {
  if (game === 'sr' || game === 'star' || game === '星铁') return 'sr'
  if (game === 'zzz' || game === '绝区零') return 'zzz'
  if (game === 'bh3' || game === '崩三' || game === '崩坏3') return 'bh3'
  return 'gs'
}

function readYaml(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return YAML.parse(fs.readFileSync(filePath, 'utf-8')) || {}
    }
  } catch (_) {}
  return {}
}

function classifyEntry(uid, entry = {}) {
  const region = String(entry.region || '')
  const name = String(entry.region_name || '')
  if (BH3_REGIONS.has(region)) return 'bh3'
  if (GS_REGIONS.has(region)) return 'gs'
  if (region === 'prod_qd_cn' || region.startsWith('prod_official_')) return 'sr'
  if (ZZZ_REGION_NAMES.test(name)) return 'zzz'
  if (SR_REGION_NAMES.test(name) && !GS_REGION_NAMES.test(name)) return 'sr'
  if (GS_REGION_NAMES.test(name) && region.startsWith('cn_')) return 'gs'
  if (region === 'prod_gf_cn') {
    // 星铁 / 绝区零都可能是 prod_gf_cn：用 region_name 或 UID 位数粗分
    if (ZZZ_REGION_NAMES.test(name)) return 'zzz'
    if (SR_REGION_NAMES.test(name)) return 'sr'
    const s = String(uid)
    // 绝区零官服 UID 常 < 10 位；星铁多为 9 位。无法区分时优先 sr（历史数据更多）
    if (s.length <= 8) return 'zzz'
    return 'sr'
  }
  // 无 region 时无法可靠区分原神/星铁（两者 CN UID 都是 9 位、可 1 开头）。
  // 原策略「9 位且首位 1 → sr」会把大量原神 CN UID 误判为星铁；
  // 缺 region 时保守归 gs（原神基数最大，误判面最小），有 region 的走上面精确分支。
  return 'gs'
}

function stokenPaths(qq) {
  return getStokenCandidateFiles(qq)
}

function loadStokenData(qq) {
  // 优先用统一配置解析
  const data = loadStokenYaml(qq)
  if (data && typeof data === 'object' && Object.keys(data).length) return data
  // 回退：逐文件 readYaml（兼容旧逻辑）
  for (const p of stokenPaths(qq)) {
    if (fs.existsSync(p)) {
      const d = readYaml(p)
      if (d && typeof d === 'object' && Object.keys(d).length) return d
    }
  }
  return null
}

/** 异步 sqlite3 all/get 封装（使用 Yunzai 根目录的 sqlite3） */
function openSqlite(dbPath) {
  return new Promise((resolve, reject) => {
    let sqlite3
    try {
      sqlite3 = require('sqlite3')
    } catch (e) {
      return reject(new Error('sqlite3 not available: ' + e.message))
    }
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) reject(err)
      else resolve(db)
    })
  })
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])))
  })
}

function dbClose(db) {
  return new Promise((resolve) => {
    try {
      db.close(() => resolve())
    } catch (_) {
      resolve()
    }
  })
}

async function resolveMainQq(qq) {
  try {
    if (typeof redis !== 'undefined' && redis?.get) {
      const mainId = await redis.get(`Yz:NoteUser:mainId:${qq}`)
      if (mainId) return String(mainId)
    }
  } catch (_) {}
  return String(qq)
}

async function readFromSqlite(qq) {
  const dbPath = path.join(process.cwd(), 'data/db/data.db')
  if (!fs.existsSync(dbPath)) return null

  let db
  try {
    db = await openSqlite(dbPath)
  } catch (e) {
    logger?.debug?.(`[xhh-TL][userBind] open sqlite failed: ${e.message}`)
    return null
  }

  try {
    const id = String(qq)
    const users = await dbAll(db, 'SELECT id, ltuids, games FROM Users WHERE id = ? LIMIT 1', [id])
    const user = users[0]
    if (!user) {
      // 也可能没有 Users 行但仍有 redis/stoken
      return {
        games: {},
        mysUsers: {},
        uidLists: { gs: [], sr: [], zzz: [] },
        hasRow: false,
      }
    }

    let games = {}
    try {
      games = JSON.parse(user.games || '{}') || {}
    } catch (_) {
      games = {}
    }

    const ltuids = String(user.ltuids || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const mysUsers = {}
    const uidLists = { gs: [], sr: [], zzz: [] }
    const seen = { gs: new Set(), sr: new Set(), zzz: new Set() }

    const pushUid = (game, uid, extra = {}) => {
      const g = gameKey(game)
      if (!GAMES.includes(g) || !uid) return
      const u = String(uid)
      if (seen[g].has(u)) return
      seen[g].add(u)
      uidLists[g].push({ uid: u, ...extra })
    }

    for (const ltuid of ltuids) {
      const rows = await dbAll(
        db,
        'SELECT ltuid, ck, type, uids, device FROM MysUsers WHERE ltuid = ? LIMIT 1',
        [ltuid],
      )
      const row = rows[0]
      if (!row) continue
      let uids = {}
      try {
        uids = JSON.parse(row.uids || '{}') || {}
      } catch (_) {
        uids = {}
      }
      mysUsers[String(row.ltuid)] = {
        ltuid: String(row.ltuid),
        ck: row.ck || '',
        type: row.type || 'mys',
        uids,
        device: row.device || '',
      }
      for (const g of GAMES) {
        for (const uid of uids[g] || []) {
          pushUid(g, uid, { type: 'ck', ltuid: String(row.ltuid) })
        }
      }
    }

    // 注册 UID（无 CK 也可查询部分接口；体力需要 stoken）
    for (const g of GAMES) {
      const ds = games[g] || {}
      const data = ds.data || {}
      // games[g].uid 是「当前主 UID」，但 #删除ck 只删通行证、不会清它，删号后它会
      // 残留成孤儿。已解绑的号不该再进 UID 列表（否则列表、绑定提示里会「复活」它）。
      // 判据与 genshin 的 getUidList 一致：列表 = mysUsers.uids + games.data，
      // 故只有「归属集合内的号」或「用户显式注册的号」才收 games[g].uid；
      // 完全没有归属信息（纯扫码 stoken 用户 / 宿主无 genshin）时保持旧行为全收。
      const owned = ownedUidsOf(mysUsers, g)
      const mainUsable = ds.uid && (!owned.size || owned.has(String(ds.uid)) || !!data[ds.uid])
      if (mainUsable) pushUid(g, ds.uid, { type: data[ds.uid]?.type || 'reg' })
      for (const uid of Object.keys(data)) {
        pushUid(g, uid, { type: data[uid]?.type || 'reg' })
      }
    }

    // 主 UID 排到列表最前
    for (const g of GAMES) {
      const main = String(games[g]?.uid || '')
      if (!main) continue
      const list = uidLists[g]
      const idx = list.findIndex((x) => String(x.uid) === main)
      if (idx > 0) {
        const [item] = list.splice(idx, 1)
        list.unshift(item)
      }
    }

    return { games, mysUsers, uidLists, hasRow: true, ltuids }
  } catch (e) {
    logger?.debug?.(`[xhh-TL][userBind] read sqlite failed: ${e.message}`)
    return null
  } finally {
    if (db) await dbClose(db)
  }
}

async function readMainUidFromRedis(qq, game) {
  const g = gameKey(game)
  const keys = {
    gs: [`Yz:genshin:mys:qq-uid:${qq}`],
    sr: [`Yz:srJson:mys:qq-uid:${qq}`, `Yz:sr:mys:qq-uid:${qq}`],
    zzz: [`Yz:zzz:mys:qq-uid:${qq}`, `Yz:nap:mys:qq-uid:${qq}`],
  }[g] || []
  try {
    if (typeof redis === 'undefined' || !redis?.get) return ''
    for (const k of keys) {
      const v = await redis.get(k)
      if (v) return String(v)
    }
  } catch (_) {}
  return ''
}

function readFromStokenYaml(qq) {
  const data = loadStokenData(qq)
  if (!data) return null

  const mysUsers = {}
  const uidLists = { gs: [], sr: [], zzz: [], bh3: [] }
  const seen = { gs: new Set(), sr: new Set(), zzz: new Set(), bh3: new Set() }

  for (const [key, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== 'object') continue
    const uid = String(entry.uid || key)
    if (!uid || !/^\d+$/.test(uid)) continue
    const g = classifyEntry(uid, entry)
    if (!uidLists[g]) continue
    if (seen[g].has(uid)) continue
    seen[g].add(uid)
    uidLists[g].push({
      uid,
      type: 'stoken',
      region: entry.region || '',
      region_name: entry.region_name || '',
      stuid: entry.stuid || entry.ltuid || '',
    })

    const stuid = entry.stuid || entry.ltuid
    if (stuid) {
      const lt = String(stuid)
      if (!mysUsers[lt]) {
        // 体力 widget 主要用 stoken；崩三等需要 cookie 时再拼
        const ck =
          entry.ck ||
          entry.cookie ||
          (entry.ltoken && entry.stuid
            ? `ltoken=${entry.ltoken};ltuid=${entry.stuid};${entry.cookie_token ? `cookie_token=${entry.cookie_token};account_id=${entry.stuid};` : ''}`
            : '') ||
          entry.ck_stoken ||
          ''
        mysUsers[lt] = {
          ltuid: lt,
          ck,
          stoken: entry.stoken || '',
          mid: entry.mid || '',
          type: 'mys',
        }
      }
    }
  }

  return { games: {}, mysUsers, uidLists }
}

/**
 * stoken yaml 的「存活账号」闸门。
 *
 * 宿主（Users 表）一旦有了该 QQ 的绑定行，它就是绑定的唯一权威：用户 #删除ck 之后，
 * xiaoyao / 扫码登录写下的那份 yaml 不会被清理，残留条目若原样并入，体力总览、多号
 * 列表就会把早已解绑的账号重新「复活」并逐个请求接口（单号查询走 getstoken，那边
 * 有同样的判定，所以只有多号枚举会出现这种不一致）。
 *
 * 这里只保留 stuid 仍在 Users.ltuids 里的条目 —— 与 Runtime 侧 mergeRuntimeSupplements
 * 的闸门同一语义：yaml 只能给存活账号补凭证与 UID，不能凭空复活账号。
 *
 * Users 无行（纯扫码 stoken 用户 / 宿主没装 genshin）或读库失败时不做任何过滤；
 * 没有 stuid 的老条目无法归属，原样保留。
 */
function gateStokenYamlByAliveIds(yamlPart, sqlitePart) {
  if (!yamlPart) return yamlPart
  if (!sqlitePart?.hasRow) return yamlPart
  const alive = new Set((sqlitePart.ltuids || []).map(String))

  const dropped = []
  const uidLists = {}
  for (const [game, list] of Object.entries(yamlPart.uidLists || {})) {
    uidLists[game] = (list || []).filter((item) => {
      const stuid = String(item?.stuid || item?.ltuid || '')
      if (!stuid || alive.has(stuid)) return true
      dropped.push(String(item?.uid || ''))
      return false
    })
  }

  const mysUsers = {}
  for (const [stuid, entry] of Object.entries(yamlPart.mysUsers || {})) {
    if (alive.has(String(stuid))) mysUsers[stuid] = entry
  }

  if (dropped.length) {
    logger?.info?.(
      `[xhh-TL][userBind] 跳过 stoken yaml 里已解绑账号的 ${dropped.length} 个 UID：${dropped.join('、')}`,
    )
  }
  return { games: yamlPart.games || {}, mysUsers, uidLists }
}

/** 某游戏下「已被存活通行证声明归属」的 UID 集合（读 mysUsers[].uids）。 */
function ownedUidsOf(mysUsers, game) {
  const set = new Set()
  for (const mys of Object.values(mysUsers || {})) {
    for (const u of mys?.uids?.[game] || []) {
      if (u) set.add(String(u))
    }
  }
  return set
}

function mergeBindData(...parts) {
  const out = {
    games: {},
    mysUsers: {},
    uidLists: { gs: [], sr: [], zzz: [] },
  }
  const seen = { gs: new Set(), sr: new Set(), zzz: new Set() }

  for (const part of parts) {
    if (!part) continue
    // SQLite 是绑定来源；原版 xiaoyao YAML 常只有 ltoken/stoken，
    // 只能补资料，不能把数据库中的完整登录 CK 覆盖成残缺 CK。
    for (const [sid, mys] of Object.entries(part.mysUsers || {})) {
      const current = out.mysUsers[sid]
      const merged = { ...current, ...mys }
      const hasCookieToken = (ck) => /(?:^|;)[ 	]*cookie_token(?:_v2)?=[^;\s]+/.test(ck || '')
      if (current?.ck && (hasCookieToken(current.ck) || !hasCookieToken(mys.ck))) {
        merged.ck = current.ck
      }
      if (current?.uids) merged.uids = current.uids
      out.mysUsers[sid] = merged
    }
    for (const g of GAMES) {
      if (part.games?.[g]?.uid && !out.games[g]?.uid) {
        out.games[g] = out.games[g] || { uid: '', data: {} }
        out.games[g].uid = String(part.games[g].uid)
      }
      for (const item of part.uidLists?.[g] || []) {
        const u = String(item.uid || item)
        if (!u || seen[g].has(u)) continue
        seen[g].add(u)
        out.uidLists[g].push(typeof item === 'object' ? item : { uid: u })
      }
    }
  }

  // 主 UID 提前（只在它本来就在列表里时调整顺序）。
  // 不在列表里 ≠ 需要补进去：#删除ck 后 games[g].uid 会残留成孤儿，而列表已由
  // 各数据源按归属/注册过滤掉它 —— 此时再 unshift 就等于把解绑的号「复活」。
  for (const g of GAMES) {
    const main = String(out.games[g]?.uid || '')
    if (!main) continue
    const list = out.uidLists[g]
    const idx = list.findIndex((x) => String(x.uid) === main)
    if (idx > 0) {
      const [item] = list.splice(idx, 1)
      list.unshift(item)
    }
  }
  return out
}

/**
 * 轻量用户对象，API 对齐 genshin NoteUser 的常用子集
 */
class BindUser {
  constructor(qq, data) {
    this.qq = String(qq)
    this.mysUsers = data.mysUsers || {}
    this._games = data.games || {}
    this._uidLists = data.uidLists || { gs: [], sr: [], zzz: [] }
  }

  get hasCk() {
    return Object.keys(this.mysUsers || {}).length > 0
  }

  getUid(game = 'gs') {
    const g = gameKey(game)
    if (g === 'bh3') return this._uidLists.bh3?.[0]?.uid || ''
    const list = this.getUidList(g)
    const first = list[0] ? String(list[0].uid || list[0]) : ''
    const main = this._games[g]?.uid ? String(this._games[g].uid) : ''

    // games[g].uid 是「当前主 UID」，但 #删除ck 只删通行证、不会把它清掉，
    // 删号后它会残留成孤儿（UID 列表里其实已经没有它了）。两个来源必须自洽：
    // 只要还有通行证声明过归属（mysUsers[].uids[g] 非空），返回的 UID 就必须在
    // 归属集合里 —— 否则视作残留，回退到列表里第一个真正被拥有的号。
    // 完全没有归属信息时（纯扫码 stoken 用户 / 宿主无 genshin）保持旧行为。
    const owned = ownedUidsOf(this.mysUsers, g)
    if (owned.size) {
      if (main && owned.has(main)) return main
      for (const item of list) {
        const u = String(item?.uid ?? item ?? '')
        if (u && owned.has(u)) return u
      }
      return ''
    }
    if (main) return main
    return first
  }

  getUidList(game = 'gs') {
    const g = gameKey(game)
    if (g === 'bh3') return this._uidLists.bh3 || []
    return this._uidLists[g] || []
  }

  getMysUser(game = 'gs') {
    const list = this.getUidList(game)
    for (const item of list) {
      if (item.ltuid && this.mysUsers[item.ltuid]) return this.mysUsers[item.ltuid]
    }
    const keys = Object.keys(this.mysUsers || {})
    return keys.length ? this.mysUsers[keys[0]] : false
  }
}

/**
 * 尝试使用 Runtime / e.user 上的 NoteUser（不 import genshin）
 */
async function tryRuntimeNoteUser(qq, e) {
  try {
    const NoteUser = e?.runtime?.NoteUser
    if (!e?.runtime?._xhhCompatNoteUser && NoteUser?.create) {
      const user = await NoteUser.create(qq)
      if (user && typeof user.getUid === 'function') return wrapLegacyUser(user)
    }
  } catch (_) {}

  try {
    if (e?.user && String(e.user.qq || e.user_id || '') === String(qq) && typeof e.user.getUid === 'function') {
      return wrapLegacyUser(e.user)
    }
  } catch (_) {}

  return null
}

/**
 * Whether the current event has an authoritative Runtime binding provider.
 * When this is true, callers must not resurrect credentials from standalone
 * stoken yaml files after Runtime has removed an account.
 */
export function hasRuntimeBinding(e) {
  try {
    return !e?.runtime?._xhhCompatNoteUser && typeof e?.runtime?.NoteUser?.create === 'function'
  } catch (_) {
    return false
  }
}

function wrapLegacyUser(user) {
  // 直接返回原对象（已具备 getUid / getUidList / mysUsers）
  if (typeof user.getUidList === 'function' && user.mysUsers !== undefined) {
    return user
  }
  // 兜底包装
  return {
    qq: user.qq,
    mysUsers: user.mysUsers || {},
    get hasCk() {
      return !!(user.hasCk || Object.keys(user.mysUsers || {}).length)
    },
    getUid(game = 'gs') {
      return user.getUid?.(game) || user.uid || ''
    },
    getUidList(game = 'gs') {
      if (typeof user.getUidList === 'function') return user.getUidList(game) || []
      const uid = this.getUid(game)
      return uid ? [{ uid: String(uid) }] : []
    },
    getMysUser(game = 'gs') {
      return user.getMysUser?.(game) || false
    },
  }
}

function mergeRuntimeSupplements(runtimeUser, qq) {
  const runtimeMys = runtimeUser?.mysUsers || {}
  const aliveIds = new Set(Object.keys(runtimeMys).map(String))
  if (!aliveIds.size) return runtimeUser

  const yamlPart = readFromStokenYaml(qq)
  if (!yamlPart) return runtimeUser

  const lists = {}
  const supplementalUids = {}
  for (const game of GAMES) {
    const base = runtimeUser.getUidList?.(game) || []
    const seen = new Set(base.map((item) => String(item?.uid || item)))
    lists[game] = [...base]

    for (const item of yamlPart.uidLists?.[game] || []) {
      const uid = String(item?.uid || '')
      const stuid = String(item?.stuid || item?.ltuid || '')
      if (!uid || !aliveIds.has(stuid)) continue

      supplementalUids[stuid] ||= {}
      supplementalUids[stuid][game] ||= []
      if (!supplementalUids[stuid][game].includes(uid)) {
        supplementalUids[stuid][game].push(uid)
      }

      if (!seen.has(uid)) {
        seen.add(uid)
        lists[game].push({ ...item, stuid, ltuid: stuid })
      }
    }
  }

  const mysUsers = { ...runtimeMys }
  for (const stuid of aliveIds) {
    const current = runtimeMys[stuid]
    const supplement = yamlPart.mysUsers?.[stuid]
    if (!current || !supplement) continue

    const merged = Object.assign(
      Object.create(Object.getPrototypeOf(current) || Object.prototype),
      current,
    )
    if (!merged.stoken && supplement.stoken) merged.stoken = supplement.stoken
    if (!merged.mid && supplement.mid) merged.mid = supplement.mid

    const uids = { ...(current.uids || {}) }
    for (const game of GAMES) {
      const values = [
        ...(uids[game] || []),
        ...(supplementalUids[stuid]?.[game] || []),
      ].map(String)
      if (values.length) uids[game] = [...new Set(values)]
    }
    merged.uids = uids
    mysUsers[stuid] = merged
  }

  const getUid = (game = 'gs') => {
    const key = gameKey(game)
    const owned = ownedUidsOf(mysUsers, key)
    const main = runtimeUser.getUid?.(key) ? String(runtimeUser.getUid(key)) : ''
    // 同 BindUser.getUid：宿主主 UID 可能残留成孤儿（#删除ck 不清 games[g].uid），
    // 有归属信息时以归属集合为准，回退到列表里第一个真正被拥有的号。
    if (owned.size) {
      if (main && owned.has(main)) return main
      for (const item of lists[key] || []) {
        const u = String(item?.uid ?? item ?? '')
        if (u && owned.has(u)) return u
      }
      return ''
    }
    return main || lists[key]?.[0]?.uid || ''
  }
  const getUidList = (game = 'gs') => lists[gameKey(game)] || []
  const getMysUser = (game = 'gs') => {
    const key = gameKey(game)
    for (const item of lists[key] || []) {
      const stuid = String(item?.ltuid || item?.stuid || '')
      if (stuid && mysUsers[stuid]) return mysUsers[stuid]
    }
    const native = runtimeUser.getMysUser?.(key)
    if (native) {
      const stuid = String(native.ltuid || native.stuid || '')
      return mysUsers[stuid] || native
    }
    const ids = Object.keys(mysUsers)
    return ids.length ? mysUsers[ids[0]] : false
  }

  return new Proxy(runtimeUser, {
    get(target, key) {
      if (key === 'mysUsers') return mysUsers
      if (key === 'hasCk') return !!(target.hasCk || Object.keys(mysUsers).length)
      if (key === 'getUid') return getUid
      if (key === 'getUidList') return getUidList
      if (key === 'getMysUser') return getMysUser
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * 创建绑定用户
 * @param {string|number|object} qqOrE - QQ 或 e 消息对象
 * @param {object} [e] - 可选事件，用于 Runtime 回退
 */
export async function createUser(qqOrE, e = null) {
  let qq = qqOrE
  let event = e
  if (qqOrE && typeof qqOrE === 'object' && qqOrE.user_id) {
    event = qqOrE
    qq = qqOrE.originalUserId || qqOrE.user_id
  }
  qq = await resolveMainQq(qq)

  // Runtime decides which accounts are alive. Standalone yaml may only add
  // game UIDs/stoken to those accounts; it can never restore a removed stuid.
  const runtimeUser = await tryRuntimeNoteUser(qq, event)
  if (runtimeUser) return mergeRuntimeSupplements(runtimeUser, qq)

  // 2) SQLite + stoken + redis
  const sqlitePart = await readFromSqlite(qq)
  const yamlPart = gateStokenYamlByAliveIds(readFromStokenYaml(qq), sqlitePart)
  const redisGames = {}
  for (const g of GAMES) {
    const uid = await readMainUidFromRedis(qq, g)
    if (uid) redisGames[g] = { uid, data: { [uid]: { uid, type: 'redis' } } }
  }
  const redisPart = {
    games: redisGames,
    mysUsers: {},
    uidLists: {
      gs: redisGames.gs ? [{ uid: redisGames.gs.uid, type: 'redis' }] : [],
      sr: redisGames.sr ? [{ uid: redisGames.sr.uid, type: 'redis' }] : [],
      zzz: redisGames.zzz ? [{ uid: redisGames.zzz.uid, type: 'redis' }] : [],
    },
  }

  const merged = mergeBindData(sqlitePart, yamlPart, redisPart)
  if (yamlPart?.uidLists?.bh3) {
    merged.uidLists.bh3 = yamlPart.uidLists.bh3
  }
  return new BindUser(qq, merged)
}

/**
 * 读取某 QQ 在 Yunzai 绑定库中「存活」的米游社账号 id（Users.ltuids）。
 * genshin 的 #删除ck 会把对应 ltuid 从 Users.ltuids 移除，据此判断某个 stoken 是否还该被启用。
 *
 * 返回：
 * - { hasRow: false, ids: Set }        —— 该 QQ 没有 Users 绑定行（纯 stoken 用户 / 无 genshin），
 *                                          调用方应保持「直接用 stoken」的旧行为，不做 gating。
 * - { hasRow: true,  ids: Set<string>} —— 有绑定行；ids 为当前存活的米游社账号 id 集合（可能为空）。
 */
export async function getAliveMysIds(qqOrE) {
  let qq = qqOrE
  if (qqOrE && typeof qqOrE === 'object' && qqOrE.user_id) {
    qq = qqOrE.originalUserId || qqOrE.user_id
  }
  qq = await resolveMainQq(qq)

  const dbPath = path.join(process.cwd(), 'data/db/data.db')
  if (!fs.existsSync(dbPath)) return { hasRow: false, ids: new Set() }

  let db
  try {
    db = await openSqlite(dbPath)
  } catch (_) {
    return { hasRow: false, ids: new Set() }
  }
  try {
    const rows = await dbAll(db, 'SELECT ltuids FROM Users WHERE id = ? LIMIT 1', [String(qq)])
    if (!rows[0]) return { hasRow: false, ids: new Set() }
    const ids = new Set(
      String(rows[0].ltuids || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    return { hasRow: true, ids }
  } catch (_) {
    return { hasRow: false, ids: new Set() }
  } finally {
    if (db) await dbClose(db)
  }
}

/** 兼容旧名 */
export const NoteUserCompat = { create: createUser }

export default { create: createUser, createUser }
