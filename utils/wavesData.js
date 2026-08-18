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
import { config, resolveConfiguredPaths } from './pluginConfig.js'
import { openReadonlyDb, getSqliteDriver, sqliteUnavailableMessage } from './sqlite.js'

/** core 数据库默认位置（按顺序探测，取第一个存在的） */
const GSUID_DB_CANDIDATES = [
  '/opt/gsuid_core/data/GsData.db',
  '/root/gsuid_core/data/GsData.db',
]

/** 库街区接口（与 XutheringWavesUID 的 api.py 保持一致） */
const MAIN_URL = 'https://api.kurobbs.com'
/**
 * 小组件数据：一次拿全体力/活跃度/周本/深塔/海墟/活动。
 * refresh 与 getData 返回结构完全一致，区别是新鲜度：
 *   · refresh — 让库街区回游戏服务器重新取数（xw 的 get_daily_info 就用这个），
 *               但约 1 分钟内只准调一次，再调返回「操作频繁，请稍后再试」
 *   · getData — 只读小组件那份缓存快照，不会主动更新，实测比 refresh 落后
 *               （同一秒 refresh 给结晶单质 32、getData 给 31）；没人刷新时能一直陈旧下去，
 *               体力曾停在 236/240 不动，害得 237 的推送阈值永远不触发
 * 所以先 refresh，被限流再退回 getData，保证有数据可用。
 * 注意 refresh 只保证「库街区侧最新」：库街区与游戏服务器之间还有一层同步延迟，
 * 刚在游戏里清掉的体力/刚做满的活跃度，两个接口都可能要等一会儿才反映（xw 同样如此）。
 */
const MR_REFRESH_URL = `${MAIN_URL}/gamer/widget/game3/refresh`
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

/**
 * 最近一次环境级失败的简短说明（驱动缺失 / 找不到库 / 读库报错）。
 * 空账号既可能是「这人没登录」，也可能是「机器人这边根本读不到库」，
 * 后者若也回「请先登录」会把人往错方向带，所以单独记一份给用户看。
 */
let envError = ''

export function getWavesEnvError() {
  return envError
}


/** 总开关（锅巴「启用鸣潮体力」） */
export function isWavesTlEnabled(cfg = config()) {
  return !!cfg?.waves_tl_enable
}

/** GsData.db 候选路径：配置优先，默认候选兜底。 */
export function resolveGsuidDbPaths(cfg = config()) {
  const custom = cfg?.waves_tl_gsuid_db || cfg?.bbs_coin_gsuid_db || ''
  // 双环境（本机 Windows / 服务器 Linux）来回抄配置时最容易踩的坑：
  // 盘符路径在 Linux 下不是绝对路径，会被拼到 Yunzai 目录下变成一条谁也看不懂的路径
  if (custom && process.platform !== 'win32' && /(^|[\n,;])\s*[A-Za-z]:[\\/]/.test(String(custom))) {
    log().warn?.(
      `[xhh-TL][鸣潮体力] 配置的是 Windows 盘符路径，但当前进程跑在 ${process.platform}；` +
        'Docker/WSL 请改成容器内可见的路径',
    )
  }
  const candidates = resolveConfiguredPaths(custom, GSUID_DB_CANDIDATES)
  const found = []
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) found.push(file)
      else if (custom) log().warn?.(`[xhh-TL][鸣潮体力] 配置的数据库路径不存在：${file}`)
    } catch (err) {
      log().warn?.(`[xhh-TL][鸣潮体力] 检查数据库路径失败：${file} (${err?.message || err})`)
    }
  }
  return found
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
 * @returns {Promise<Array<{uid,cookie,did,bat,net}>>}
 */
export async function listWavesAccounts(qq, cfg = config()) {
  const out = []
  envError = ''
  const driver = await getSqliteDriver()
  if (!driver) {
    envError = '机器人缺少可用的 SQLite 驱动，请看控制台日志'
    log().warn?.(`[xhh-TL][鸣潮体力] ${sqliteUnavailableMessage()}`)
    return out
  }
  const paths = resolveGsuidDbPaths(cfg)
  if (!paths.length) {
    envError = '没找到 gsuid_core 的 GsData.db，请在锅巴里填写数据库路径'
    log().warn?.(
      '[xhh-TL][鸣潮体力] 未找到可用的 GsData.db。' +
        'Windows/Docker 请在锅巴「gsuid_core 数据库路径」里填写 Yunzai 进程能访问到的绝对路径，' +
        '例如 D:/QingShuiBot/gsuid_core/data/GsData.db',
    )
    return out
  }

  for (const file of paths) {
    let db = null
    try {
      db = await openReadonlyDb(file)
      const bind = await db.all('SELECT uid FROM wavesbind WHERE user_id = ?', [String(qq)])
      // 绑定顺序即展示顺序，去重后作为白名单
      const order = []
      for (const row of bind) {
        for (const uid of String(row.uid || '').split('_')) {
          const u = uid.trim()
          if (u && !order.includes(u)) order.push(u)
        }
      }
      const users = await db.all(
        `SELECT uid, cookie, did, bat, status
           FROM wavesuser
          WHERE user_id = ? AND game_id = ? AND cookie IS NOT NULL AND cookie != ''`,
        [String(qq), WAVES_GAME_ID],
      )

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
      if (!out.length) {
        // 库和表都读通了，只是这个 QQ 没登录过 —— 与「找不到库」区分开，省得瞎调路径
        log().debug?.(
          `[xhh-TL][鸣潮体力] ${file}（${db.driver}）里 ${qq} 有 ${bind.length} 条绑定、${users.length} 条凭证，无可用账号`,
        )
      }
    } catch (err) {
      envError = `读取 gsuid_core 数据库失败（${err?.code || err?.name || 'SQLite'}）`
      log().warn?.(
        `[xhh-TL][鸣潮体力] 读取数据库失败：${file}（${driver.name}）` +
          `(${err?.code || err?.name || 'SQLite'}: ${err?.message || err})`,
      )
    } finally {
      try {
        await db?.close()
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
  const idBody = { gameId: String(WAVES_GAME_ID), serverId, roleId: acc.uid }
  let daily = null
  let lastErr = null

  // refresh 拿实时值，撞限流（或任何非成功返回）再退回 getData 的缓存快照
  for (const [url, extra] of [
    [MR_REFRESH_URL, { type: '1', sizeType: '2' }],
    [GAME_DATA_URL, { type: '2', sizeType: '1' }],
  ]) {
    try {
      const res = await postKuro(url, acc, { ...extra, ...idBody }, true, timeoutMs)
      if (res.success && res.data) {
        daily = res
        break
      }
      lastErr = res.msg || '库街区返回异常'
    } catch (err) {
      lastErr = err?.name === 'AbortError' ? '库街区响应超时' : `库街区请求失败：${err?.message || err}`
      // 超时/网络故障时 getData 大概率同样打不通，但便宜，还是试一把
    }
    if (url === MR_REFRESH_URL) {
      log().debug?.(`[xhh-TL][鸣潮体力] ${acc.uid} refresh 未成功（${lastErr}），退回 getData 缓存`)
    }
  }
  if (!daily) return lastErr || '库街区返回异常'

  // baseData 是补充信息，坏了就用小组件接口里已有的部分
  let base = null
  try {
    const res = await postKuro(BASE_DATA_URL, acc, idBody, false, timeoutMs)
    if (res.success && res.data && typeof res.data === 'object') base = res.data
  } catch (_) {}

  return normalizeWavesItem(acc, daily.data, base)
}

/** 小组件数据 + baseData → 体力卡 item（字段风格对齐三游戏） */
export function normalizeWavesItem(acc, d, base) {
  const energy = d.energyData || {}
  const liveness = d.livenessData || {}
  const store = d.storeEnergyData || {}
  const bp = Array.isArray(d.battlePassData) ? d.battlePassData : []
  const weekly = d.weeklyData || {}
  const rogue = d.weeklyRougeData || {}
  const frame = d.weeklyFrameData || {}
  const act = d.activityData || {}

  // 战歌重奏：库街区两处给的都是「剩余可收取次数」（baseData 字段名就叫
  // weeklyInstTitle=战歌重奏收取次数，与游戏内「本周剩余可收取次数 3/3」同一口径），
  // 不能再拿 total 去减，否则一次没打时会被算成「已用完」
  const bossTotal = Number(base?.weeklyInstCountLimit ?? weekly.total) || 0
  const bossLeft = Number(base?.weeklyInstCount ?? weekly.cur) || 0

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

    // 战歌重奏（周本）：剩余可收取次数
    boss_left: bossTotal ? Math.min(bossLeft, bossTotal) : bossLeft,
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
  const accounts = await listWavesAccounts(qq, cfg)
  // 环境问题（缺驱动/找不到库/读库报错）原样透给用户，别一律说「没登录」
  if (!accounts.length) return { items: [], error: getWavesEnvError() || '没有' }

  const all = opts.all ?? cfg.show_all_bindings !== false
  const picked = all ? accounts : accounts.slice(0, 1)
  const timeoutMs = Math.max(5, Number(cfg.waves_tl_timeout) || 15) * 1000

  const results = await Promise.all(picked.map((acc) => fetchWavesStamina(acc, timeoutMs)))
  const items = results.filter((r) => r && typeof r === 'object')
  if (items.length) return { items, error: null }

  const errs = results.filter((r) => typeof r === 'string')
  return { items: [], error: errs[0] || '鸣潮体力查询失败' }
}
