import fetch from 'node-fetch'

export const GAMES = {
  gs: { biz: 'hk4e_cn', host: 'https://hk4e-api.mihoyo.com', name: '原神', source: 'genshin', official: '75276539', gid: 2 },
  sr: { biz: 'hkrpg_cn', host: 'https://public-operation-hkrpg.mihoyo.com', name: '星铁', source: 'hsr', official: '80823548', gid: 6 },
  zzz: { biz: 'nap_cn', host: 'https://public-operation-nap.mihoyo.com', name: '绝区零', source: 'zzz', official: '152039148', gid: 8 },
}
export const SEEN_TTL = 7 * 24 * 3600
export const TERMINAL = new Set([0, -2001, -2003, -2017, -2018])
const PERMANENT_CODES = new Set(['GENSHINGIFT', 'STARRAILGIFT', 'ZENLESSGIFT'])
export const MESSAGES = {
  0: '兑换成功，奖励请到游戏内邮箱领取',
  '-2001': '兑换码已过期', '-2003': '无效的兑换码',
  '-2016': '兑换冷却中，请稍后再试',
  '-2017': '该兑换码已被使用', '-2018': '该兑换码已被使用',
  '-1071': '请发送 #扫码登录 后再试', '-1033': '请发送 #扫码登录 后再试',
  '-1035': '请稍后再试', '-100': '请发送 #扫码登录 后再试',
}
export const COMMAND_REG = '^\\s*([#*%])(?:(原神|星铁|绝区零))?(使用兑换码|兑换码使用|自动兑换码)([\\s\\S]*)$'
export function parseCommand(msg) {
  const m = String(msg || '').match(new RegExp(COMMAND_REG))
  if (!m) return null
  const game = ({ 原神: 'gs', 星铁: 'sr', 绝区零: 'zzz' })[m[2]] || ({ '#': 'gs', '*': 'sr', '%': 'zzz' })[m[1]]
  const arg = m[4].trim()
  if (m[3] === '自动兑换码') {
    const action = !arg || arg === '开启' ? 'on' : arg === '关闭' ? 'off' : arg === '状态' ? 'status' : 'usage'
    return { game, action }
  }
  const codes = arg ? [...new Set(arg.toUpperCase().split(/[\s,，;；]+/))] : null
  if (codes && (codes.length > 20 || codes.some(c => !/^[A-Z0-9]{2,64}$/.test(c)))) return { game, action: 'usage' }
  return { game, action: 'redeem', codes }
}
// Node >=16，node-fetch v2/v3 通用；不依赖 v2 timeout / 新版 AbortSignal.timeout。
export async function requestJson(url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, redirect: 'error', size: 2 * 1024 * 1024 })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('接口返回格式异常')
    return data
  } finally { clearTimeout(timer) }
}
function check(data) {
  if (data.retcode !== 0) throw new Error(`接口返回 retcode=${data.retcode}`)
  return data.data
}
function recent(time, now) {
  const t = Number(time)
  return Number.isFinite(t) && t > 0 && t <= now + 300 && t >= now - SEEN_TTL
}
export function normalizeCodes(rows, now = Math.floor(Date.now() / 1000)) {
  const codes = new Map()
  for (const row of rows || []) {
    const code = String(row?.code || '').trim().toUpperCase()
    if (!/^[A-Z0-9]{2,64}$/.test(code) || PERMANENT_CODES.has(code) || !recent(row.added_at, now)) continue
    if (!codes.has(code)) codes.set(code, { code, added_at: Number(row.added_at) })
  }
  return [...codes.values()]
}
const cache = new Map()
async function cached(key, fn) {
  const old = cache.get(key)
  if (old && old.until > Date.now()) return old.promise
  const entry = { until: Date.now() + 5 * 60000 }
  entry.promise = fn().catch(err => { if (cache.get(key) === entry) cache.delete(key); throw err })
  cache.set(key, entry)
  return entry.promise
}
async function community(game) {
  const data = await cached('community', () => requestJson('https://db.hashblen.com/codes'))
  if (data.retcode !== 0 || !Array.isArray(data[GAMES[game].source])) throw new Error('社区码表结构异常')
  return normalizeCodes(data[GAMES[game].source])
}
// 与现有查码指令同源；不依赖 genshin 的国际服 useCdk 实现。
async function official(game) {
  const g = GAMES[game]
  const posts = check(await requestJson(`https://bbs-api.mihoyo.com/painter/api/user_instant/list?offset=0&size=20&uid=${g.official}`))
  if (!Array.isArray(posts?.list)) throw new Error('官方帖子结构异常')
  const now = Math.floor(Date.now() / 1000)
  let act = '', created = 0
  for (const item of posts.list) {
    const post = item?.post?.post
    if (!recent(post?.created_at, now)) continue
    const id = String(post.structured_content || '').match(/act_id=([a-zA-Z0-9]+)/)?.[1]
    if (id && Number(post.created_at) > created) { act = id; created = Number(post.created_at) }
  }
  if (!act) {
    const nav = check(await requestJson(`https://bbs-api.miyoushe.com/apihub/api/home/new?gids=${g.gid}&parts=1%2C3%2C4`))
    const item = nav?.navigator?.find(x => /前瞻|特别节目/.test(x.name || '') && /act_id=/.test(x.app_path || ''))
    act = item?.app_path?.match(/act_id=([a-zA-Z0-9]+)/)?.[1]
  }
  if (!act) return []
  const headers = { 'x-rpc-act_id': act }
  const live = check(await requestJson('https://api-takumi.mihoyo.com/event/miyolive/index', { headers }))?.live
  if (!live) throw new Error('官方直播结构异常')
  if (Number(live.remain) > 0) return []
  const q = new URLSearchParams({ version: String(live.code_ver), time: String(now) })
  const data = check(await requestJson(`https://api-takumi-static.mihoyo.com/event/miyolive/refreshCode?${q}`, { headers }))
  if (!Array.isArray(data?.code_list)) throw new Error('官方码表结构异常')
  return normalizeCodes(data.code_list.map(x => ({ code: x.code, added_at: Number(x.to_get_time) || created })), now)
}
/** 自动兑换只允许官方前瞻源；独立缓存，不回退社区或手动取码结果。 */
export async function getAutoCodes(game) {
  return cached('auto-live:' + game, () => official(game))
}
export async function getCodes(game) {
  return cached(`codes:${game}`, async () => {
    const rows = []
    let available = 0
    for (const [label, fn] of [['官方', official], ['社区', community]]) {
      try { rows.push(...await fn(game)); available++ } catch (err) {
        globalThis.logger?.warn?.(`[xhh-TL][兑换码] ${game}/${label}码源失败: ${err.message}`)
      }
    }
    if (!available) throw new Error('所有码源均不可用')
    return normalizeCodes(rows)
  })
}
export async function getRoles(game, ck) {
  const data = await requestJson(`https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie?game_biz=${GAMES[game].biz}`, { headers: { Cookie: ck } })
  if (data.retcode !== 0) return { retcode: data.retcode, roles: [] }
  if (!Array.isArray(data.data?.list)) throw new Error('绑定角色结构异常')
  return { retcode: 0, roles: data.data.list.filter(r => r.game_biz === GAMES[game].biz && r.game_uid && r.region) }
}
export async function redeemCode(game, role, ck, code) {
  const g = GAMES[game]
  const q = new URLSearchParams({ uid: String(role.game_uid), region: role.region, cdkey: code, game_biz: g.biz, lang: 'zh-cn' })
  const data = await requestJson(`${g.host}/common/apicdkey/api/webExchangeCdkey?${q}`, {
    headers: { Cookie: ck, Referer: 'https://webstatic.mihoyo.com/' },
  })
  if (typeof data.retcode !== 'number') throw new Error('兑换结果缺少 retcode')
  globalThis.logger?.info?.(`[xhh-TL][兑换码] ${game}/${role.game_uid}/${code} retcode=${data.retcode} message=${String(data.message || '').slice(0,200)}`)
  return { retcode: data.retcode, msg: MESSAGES[data.retcode] || '兑换失败，请稍后再试' }
}
