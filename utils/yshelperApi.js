/**
 * 提瓦特小助手（yshelper）深渊统计数据源
 * 上游 miao-plugin fork 的 HutaoApi 已改用此接口，替代已下线的
 * lelaer /Statistics/Team/Combination。
 *
 * getAbyssRank 返回体量较大（~180KB），做 1 小时内存缓存。
 */

import fetch from 'node-fetch'

const ABYSS_RANK_URL =
  'https://api.yshelper.com/ys/getAbyssRank.php?star=all&role=all&lang=zh-Hans'
// 幽境危战使用率统计（结构同深渊；配队分 上/中/下 三半区）
const HARD_RANK_URL =
  'https://api.yshelper.com/ys/getAbyssRank2.php?star=all&role=all&lang=zh-Hans'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

let _cache = null
let _cacheAt = 0
let _hardCache = null
let _hardCacheAt = 0
const CACHE_MS = 60 * 60 * 1000

/** 拉取原神深渊统计（含使用率 has_list + 配队 result[3]） */
export async function getAbyssRank({ force = false } = {}) {
  if (!force && _cache && Date.now() - _cacheAt < CACHE_MS) return _cache
  const res = await fetch(ABYSS_RANK_URL, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`yshelper HTTP ${res.status}`)
  const data = await res.json()
  if (!data || !data.result || !Array.isArray(data.result)) {
    throw new Error('yshelper 返回结构异常')
  }
  _cache = data
  _cacheAt = Date.now()
  return data
}

/** 拉取幽境危战统计（含使用率 has_list + 配队 result[3]，配队含 up/mid/down 三半区） */
export async function getHardRank({ force = false } = {}) {
  if (!force && _hardCache && Date.now() - _hardCacheAt < CACHE_MS) return _hardCache
  const res = await fetch(HARD_RANK_URL, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`yshelper HTTP ${res.status}`)
  const data = await res.json()
  if (!data || !data.result || !Array.isArray(data.result)) {
    throw new Error('yshelper 返回结构异常')
  }
  _hardCache = data
  _hardCacheAt = Date.now()
  return data
}

/**
 * 从 result 数组中定位「配队组合」列表。
 * 该列表元素形如 { role: [{avatar,star}...], up_use_num, down_use_num, use_rate, has_rate, attend_rate }
 */
export function pickTeamList(data) {
  if (!data || !Array.isArray(data.result)) return null
  for (const list of data.result) {
    if (
      Array.isArray(list) &&
      list.length &&
      Array.isArray(list[0]?.role) &&
      list[0].role.length
    ) {
      return list
    }
  }
  return null
}

/** has_list：角色使用率明细，用于把 role.avatar(图片URL) 反查到角色 */
export function pickHasList(data) {
  return Array.isArray(data?.has_list) ? data.has_list : []
}

/**
 * 头像 URL -> 角色中文名 的映射表。
 * 危战数据里 role.avatar 一半是腾讯系(gtimg/qpic)URL，has_list 全是米游社 URL，
 * 无法完全反查。result[1]/result[2] 的单体使用率榜带了 name + avatar，
 * 合并它们即可覆盖绝大多数头像 URL。
 */
export function buildAvatarUrlNameMap(data) {
  const map = {}
  for (const ds of pickHasList(data)) {
    if (ds?.avatar && ds?.name) map[ds.avatar] = ds.name
  }
  if (Array.isArray(data?.result)) {
    for (const list of data.result) {
      if (!Array.isArray(list)) continue
      for (const row of list) {
        if (row && typeof row === 'object' && row.avatar && row.name && !Array.isArray(row.role)) {
          if (!map[row.avatar]) map[row.avatar] = row.name
        }
      }
    }
  }
  return map
}
