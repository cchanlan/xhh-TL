/**
 * 鸣潮体力数据层
 *
 * 不再走 gsuid_core 的 WS 转发出图，而是「只借 XutheringWavesUID 的数据」：
 * 从 core 的 GsData.db 只读取出该 QQ 的鸣潮绑定（wavesbind）与登录凭证
 * （wavesuser: cookie/did/bat），然后自己请求库街区两个接口，
 * 归一化成和原神/星铁/绝区零同构的 item，交给本插件自己的体力模板渲染。
 *
 * 只读打开数据库，不写、不锁库，不影响正在跑的 gsuid_core。
 */

import fs from 'fs'
import { config } from './pluginConfig.js'

/** core 数据库默认位置（按顺序探测，取第一个存在的） */
const GSUID_DB_CANDIDATES = [
  '/opt/gsuid_core/data/GsData.db',
  '/root/gsuid_core/data/GsData.db',
]

/** 库街区接口（与 XutheringWavesUID 的 api.py 保持一致） */
const MAIN_URL = 'https://api.kurobbs.com'
/** 小组件数据：一次拿全体力/活跃度/周本/深塔/海墟/活动 */
const GAME_DATA_URL = `${MAIN_URL}/gamer/widget/game3/getData`
/** 账号基础数据：等级、结晶单质上限、周本次数、成就等 */
const BASE_DATA_URL = `${MAIN_URL}/aki/roleBox/akiBox/baseData`
/** 鸣潮 gameId 与国服 serverId */
const WAVES_GAME_ID = 3
const SERVER_ID = '76402e5b20be2c39f095a152090afddc'
const SERVER_ID_NET = '919752ae5ea09c1ced910dd668a63ffb'
/** 国际服 uid 前缀 → serverId */
const NET_SERVER_ID_MAP = {
  5: '591d6af3a3090d8ea00d8f86cf6d7501',
  6: '6eb2a235b30d05efd77bedb5cf60999e',
  7: '86d52186155b148b5c138ceb41be9650',
  8: '919752ae5ea09c1ced910dd668a63ffb',
  9: '10cd7254d57e58ae560b15d51e34b4c',
}
const IOS_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko)  KuroGameBox/3.1.3'

const log = () => (typeof logger !== 'undefined' ? logger : console)

/** node:sqlite 是 Node 22.5+ 的实验特性，老版本取不到就整体降级（鸣潮不出图） */
let DatabaseSync = null
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch (_) {
  DatabaseSync = null
}

/** 总开关（锅巴「启用鸣潮体力」） */
export function isWavesTlEnabled(cfg = config()) {
  return !!cfg?.waves_tl_enable
}

/** GsData.db 候选路径：配置优先（换行/逗号分隔），其次默认候选 */
export function resolveGsuidDbPaths(cfg = config()) {
  const custom = String(cfg?.waves_tl_gsuid_db || cfg?.bbs_coin_gsuid_db || '').trim()
  const list = custom
    ? custom.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
    : GSUID_DB_CANDIDATES
  return list.filter((p) => {
    try {
      return fs.existsSync(p)
    } catch (_) {
      return false
    }
  })
}

/** 国际服 uid（9 位以上且首位 >= 5） */
function isNetUid(uid) {
  const s = String(uid || '')
  return s.length >= 9 && Number(s[0]) >= 5
}

function serverIdOf(uid) {
  if (!isNetUid(uid)) return SERVER_ID
  return NET_SERVER_ID_MAP[Math.floor(Number(uid) / 1e8)] || SERVER_ID_NET
}

/**
 * 枚举某 QQ 名下可查的鸣潮账号
 *
 * wavesbind.uid 是「_」分隔的多 uid（第一个为当前主 uid），凭证在 wavesuser 里按 uid 存。
 * 只返回既在绑定列表、又有 cookie 的账号；xw 标为「无效」的直接跳过。
 *
 * @returns {Array<{uid,cookie,did,bat,net}>}
 */
export function listWavesAccounts(qq, cfg = config()) {
  const out = []
  if (!DatabaseSync) {
    log().debug?.('[xhh-TL][鸣潮体力] node:sqlite 不可用，跳过')
    return out
  }
  const paths = resolveGsuidDbPaths(cfg)
  if (!paths.length) return out

  for (const file of paths) {
    let db = null
    try {
      db = new DatabaseSync(file, { readOnly: true })
      const bind = db
        .prepare('SELECT uid FROM wavesbind WHERE user_id = ?')
        .all(String(qq))
      // 绑定顺序即展示顺序，去重后作为白名单
      const order = []
      for (const row of bind) {
        for (const uid of String(row.uid || '').split('_')) {
          const u = uid.trim()
          if (u && !order.includes(u)) order.push(u)
        }
      }
      const users = db
        .prepare(
          `SELECT uid, cookie, did, bat, status
             FROM wavesuser
            WHERE user_id = ? AND game_id = ? AND cookie IS NOT NULL AND cookie != ''`,
        )
        .all(String(qq), WAVES_GAME_ID)

      const byUid = new Map()
      for (const row of users) {
        if (String(row.status || '') === '无效') {
          log().debug?.(`[xhh-TL][鸣潮体力] ${row.uid} 已被 xw 标记失效，跳过`)
          continue
        }
        byUid.set(String(row.uid), {
          uid: String(row.uid),
          cookie: String(row.cookie || ''),
          did: String(row.did || ''),
          bat: String(row.bat || ''),
          net: isNetUid(row.uid),
        })
      }
      // 绑定过的排前面，没在 bind 里但有 ck 的（换绑残留）也带上
      for (const uid of order) if (byUid.has(uid)) out.push(byUid.get(uid))
      for (const [uid, acc] of byUid) if (!order.includes(uid)) out.push(acc)
    } catch (err) {
      log().debug?.(`[xhh-TL][鸣潮体力] 读 ${file} 失败：${err?.message}`)
    } finally {
      try {
        db?.close()
      } catch (_) {}
    }
    if (out.length) break
  }
  return out
}

/** 库街区请求头：与 xw 的 get_base_header + get_used_headers 同构 */
function wavesHeaders(acc, needToken) {
  const headers = {
    source: 'ios',
    'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    'User-Agent': IOS_USER_AGENT,
    // xw 用「公网IP, UA」，这里不额外请求外网测 IP，占位不影响接口
    devCode: `0.0.0.0, ${IOS_USER_AGENT}`,
    did: acc.did || '',
    'b-at': acc.bat || '',
  }
  if (needToken) headers.token = acc.cookie
  return headers
}

/** 剩余秒数 → 「今天HH:MM」，与三游戏体力卡的 time 字段同格式 */
function recoverText(refreshTimeStamp) {
  const now = Date.now()
  if (!refreshTimeStamp || refreshTimeStamp * 1000 <= now) return '已满'
  const date = new Date(refreshTimeStamp * 1000)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(refreshTimeStamp * 1000)
  target.setHours(0, 0, 0, 0)
  const days = Math.round((target - today) / 86400000)
  const day = days <= 0 ? '今天' : days === 1 ? '明天' : days === 2 ? '后天' : `${days}天后`
  return `${day}${hh}:${mm}`
}

/** 周期活动倒计时 → 「余 N 天」/「余 N 小时」/「已结束」 */
function remainText(ts) {
  if (!ts) return ''
  const left = ts * 1000 - Date.now()
  if (left <= 0) return '已结束'
  const days = Math.floor(left / 86400000)
  if (days >= 1) return `余 ${days} 天`
  return `余 ${Math.max(1, Math.floor(left / 3600000))} 小时`
}

/** 周期挑战（深塔/海墟/矩阵）统一成一个小块 */
function periodBlock(raw, doneWhen) {
  if (!raw) return null
  const cur = Number(raw.cur) || 0
  const total = Number(raw.total) || 0
  const done = typeof doneWhen === 'function' ? !!doneWhen(raw) : total > 0 && cur >= total
  const timeText = remainText(raw.refreshTimeStamp)
  return {
    name: String(raw.name || ''),
    cur,
    total,
    done,
    time_text: timeText,
    // 没做完且不到 7 天就标红催一下（与 xw 的判定一致）
    urgent: !done && !!raw.refreshTimeStamp && raw.refreshTimeStamp * 1000 - Date.now() < 7 * 86400000,
  }
}

async function postKuro(url, acc, body, needToken, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: wavesHeaders(acc, needToken),
      body: new URLSearchParams(body),
      signal: ctrl.signal,
    })
    const json = await res.json()
    // data 有时是 JSON 字符串（baseData），统一解开
    let data = json?.data
    if (typeof data === 'string' && data.trim().startsWith('{')) {
      try {
        data = JSON.parse(data)
      } catch (_) {}
    }
    return { code: json?.code, msg: json?.msg, success: json?.code === 200, data }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 查一个鸣潮 UID 的体力，归一化成体力模板用的 item
 *
 * getData（小组件接口）一次带回体力/活跃度/电台/周本/深塔/海墟/矩阵/当期活动；
 * baseData 只用来补等级、结晶单质上限、周本已用次数与账号统计，失败不影响出图。
 *
 * @returns {Promise<object|string>} item 或错误说明字符串
 */
export async function fetchWavesStamina(acc, timeoutMs = 15000) {
  const serverId = serverIdOf(acc.uid)
  let daily
  try {
    daily = await postKuro(
      GAME_DATA_URL,
      acc,
      { type: '2', sizeType: '1', gameId: String(WAVES_GAME_ID), serverId, roleId: acc.uid },
      true,
      timeoutMs,
    )
  } catch (err) {
    return err?.name === 'AbortError' ? '库街区响应超时' : `库街区请求失败：${err?.message || err}`
  }
  if (!daily.success || !daily.data) {
    return daily.msg || '库街区返回异常'
  }

  // baseData 是补充信息，坏了就用 getData 里已有的部分
  let base = null
  try {
    const res = await postKuro(
      BASE_DATA_URL,
      acc,
      { gameId: String(WAVES_GAME_ID), serverId, roleId: acc.uid },
      false,
      timeoutMs,
    )
    if (res.success && res.data && typeof res.data === 'object') base = res.data
  } catch (_) {}

  return normalizeWavesItem(acc, daily.data, base)
}

/** getData + baseData → 体力卡 item（字段风格对齐三游戏） */
export function normalizeWavesItem(acc, d, base) {
  const energy = d.energyData || {}
  const liveness = d.livenessData || {}
  const store = d.storeEnergyData || {}
  const bp = Array.isArray(d.battlePassData) ? d.battlePassData : []
  const weekly = d.weeklyData || {}
  const rogue = d.weeklyRougeData || {}
  const frame = d.weeklyFrameData || {}
  const act = d.activityData || {}

  const bossTotal = Number(base?.weeklyInstCountLimit ?? weekly.total) || 0
  const bossUsed = Number(base?.weeklyInstCount ?? weekly.cur) || 0

  return {
    uid: String(acc.uid),
    name: String(d.roleName || base?.name || ''),
    level: base?.level ?? null,
    world_level: base?.worldLevel ?? null,
    net: !!acc.net,
    // 国际服走库街区没有签到态，统一按 getData 给的来
    has_signed: !!d.hasSignIn,
    sign_txt: String(d.signInTxt || ''),

    // 主资源：结晶波片
    current_stamina: Number(energy.cur) || 0,
    max_stamina: Number(energy.total) || 240,
    time: recoverText(Number(energy.refreshTimeStamp) || 0),

    // 结晶单质（体力溢出后的存储）
    store_energy: Number(store.cur ?? base?.storeEnergy) || 0,
    max_store_energy: Number(store.total ?? base?.storeEnergyLimit) || 480,

    // 每日活跃度
    liveness: Number(liveness.cur) || 0,
    max_liveness: Number(liveness.total) || 100,

    // 先约电台（BP）：cur=等级，第二项是本周经验
    bp_level: Number(bp[0]?.cur) || 0,
    bp_week_cur: Number(bp[1]?.cur) || 0,
    bp_week_total: Number(bp[1]?.total) || 0,

    // 战歌重奏（周本）：库街区给的是已用次数，卡上显示剩余
    boss_left: Math.max(0, bossTotal - bossUsed),
    boss_total: bossTotal,

    // 周度游历 / 千道门扉的异想
    frame_cur: Number(frame.cur) || 0,
    frame_total: Number(frame.total) || 0,
    rogue_cur: Number(rogue.cur ?? base?.rougeScore) || 0,
    rogue_total: Number(rogue.total ?? base?.rougeScoreLimit) || 0,

    // 周期挑战：逆境深塔满星 36、冥歌海墟要打到「再生-湍渊」
    tower: periodBlock(d.towerData, (r) => Number(r.cur) >= 36),
    slash: periodBlock(d.slashTowerData, (r) =>
      String(r.name || '').includes('再生-湍渊') && Number(r.total) > 0 && Number(r.cur) >= Number(r.total)),
    // 终焉矩阵只有积分没有满值，done 恒真只为免掉「未完成」催促标记
    new_tower: periodBlock(d.newTowerData, () => true),

    // 当期活动（widget 卡底部「限时活动」用）
    activity: act.enabled
      ? {
          title: String(act.title || ''),
          time_text: remainText(Number(act.endTime) || 0),
          urgent: !!act.endTime && act.endTime * 1000 - Date.now() < 3 * 86400000,
          rewards: (Array.isArray(act.coreRewards) ? act.coreRewards : [])
            .map((r) => String(r?.name || ''))
            .filter(Boolean),
        }
      : null,

    // 账号统计（立绘卡底部 stats 用）
    active_days: base?.activeDays ?? null,
    role_num: base?.roleNum ?? null,
    achievement_count: base?.achievementCount ?? null,
  }
}

/**
 * 查某 QQ 的鸣潮体力
 * @param {string|number} qq
 * @param {object} [opts] { all 是否查名下全部 UID（默认跟随 show_all_bindings） }
 * @returns {Promise<{items: object[], error: string|null}>}
 */
export async function getWavesStaminaList(qq, opts = {}) {
  const cfg = config()
  const accounts = listWavesAccounts(qq, cfg)
  if (!accounts.length) return { items: [], error: '没有' }

  const all = opts.all ?? cfg.show_all_bindings !== false
  const picked = all ? accounts : accounts.slice(0, 1)
  const timeoutMs = Math.max(5, Number(cfg.waves_tl_timeout) || 15) * 1000

  const results = await Promise.all(picked.map((acc) => fetchWavesStamina(acc, timeoutMs)))
  const items = results.filter((r) => r && typeof r === 'object')
  if (items.length) return { items, error: null }

  const errs = results.filter((r) => typeof r === 'string')
  return { items: [], error: errs[0] || '鸣潮体力查询失败' }
}
