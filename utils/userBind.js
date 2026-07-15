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
  // 无 region 时按 UID 位数猜测
  const s = String(uid)
  if (/^\d{9}$/.test(s) && s[0] === '1') return 'sr'
  if (/^\d{8,10}$/.test(s) && s[0] === '1') return 'gs'
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
      return { games: {}, mysUsers: {}, uidLists: { gs: [], sr: [], zzz: [] } }
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
      if (ds.uid) pushUid(g, ds.uid, { type: ds.data?.[ds.uid]?.type || 'reg' })
      const data = ds.data || {}
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

    return { games, mysUsers, uidLists }
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
      stuid: entry.stuid || '',
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

function mergeBindData(...parts) {
  const out = {
    games: {},
    mysUsers: {},
    uidLists: { gs: [], sr: [], zzz: [] },
  }
  const seen = { gs: new Set(), sr: new Set(), zzz: new Set() }

  for (const part of parts) {
    if (!part) continue
    Object.assign(out.mysUsers, part.mysUsers || {})
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

  // 主 UID 提前
  for (const g of GAMES) {
    const main = String(out.games[g]?.uid || '')
    if (!main) continue
    const list = out.uidLists[g]
    const idx = list.findIndex((x) => String(x.uid) === main)
    if (idx > 0) {
      const [item] = list.splice(idx, 1)
      list.unshift(item)
    } else if (idx < 0) {
      list.unshift({ uid: main, type: 'main' })
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
    const main = this._games[g]?.uid
    if (main) return String(main)
    const list = this.getUidList(g)
    return list[0] ? String(list[0].uid || list[0]) : ''
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
    if (NoteUser?.create) {
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

  // 1) Runtime NoteUser（有 genshin 时最完整，且不 import genshin）
  const runtimeUser = await tryRuntimeNoteUser(qq, event)
  if (runtimeUser) {
    // 仍合并 stoken，补全 Runtime 可能缺的 zzz 等
    try {
      const yamlPart = readFromStokenYaml(qq)
      if (yamlPart) {
        const lists = {}
        for (const g of GAMES) {
          const fromRt = runtimeUser.getUidList?.(g) || []
          const seen = new Set(fromRt.map((x) => String(x.uid || x)))
          const merged = [...fromRt]
          for (const item of yamlPart.uidLists[g] || []) {
            const u = String(item.uid)
            if (!seen.has(u)) {
              seen.add(u)
              merged.push(item)
            }
          }
          lists[g] = merged
        }
        // mysUsers 合并
        const mys = { ...(runtimeUser.mysUsers || {}), ...(yamlPart.mysUsers || {}) }
        return {
          qq,
          mysUsers: mys,
          get hasCk() {
            return Object.keys(mys).length > 0
          },
          getUid(game = 'gs') {
            const g = gameKey(game)
            return runtimeUser.getUid?.(g) || lists[g]?.[0]?.uid || ''
          },
          getUidList(game = 'gs') {
            return lists[gameKey(game)] || []
          },
          getMysUser(game = 'gs') {
            return runtimeUser.getMysUser?.(game) || false
          },
        }
      }
    } catch (_) {}
    return runtimeUser
  }

  // 2) SQLite + stoken + redis
  const sqlitePart = await readFromSqlite(qq)
  const yamlPart = readFromStokenYaml(qq)
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

/** 兼容旧名 */
export const NoteUserCompat = { create: createUser }

export default { create: createUser, createUser }
