/**
 * 参量质变仪 / 洞天宝钱 到期提醒的定时器
 *
 * 设计要点：**不额外打米游社接口**。数据全部来自用户查询体力时的那份快照
 * （dailyNote，见 apps/TL.js 的质变仪补拉），这里只做三件事：
 *   1. 把「剩余秒数」换算成绝对到期时刻 dueAt
 *   2. 落盘（进程重启后能重新挂上）
 *   3. 用 setTimeout 等到点，回调交给 resinPush 去 @ 人
 *
 * 为什么不放 apps/ 下：TL.js 和 resinPush.js 都要用它，放 utils 避免循环依赖。
 * 本模块**不 import** TL / resinPush / Bot —— 发送能力由 resinPush 通过
 * registerReminderHooks() 注册进来（依赖方向：apps → utils，单向）。
 */

import fs from 'fs'
import path from 'path'
import { config, pluginDir } from './pluginConfig.js'

const log = {
  info: (...a) => (typeof logger !== 'undefined' ? logger.info?.(...a) : console.log(...a)),
  mark: (...a) => (typeof logger !== 'undefined' ? logger.mark?.(...a) : console.log(...a)),
  error: (...a) => (typeof logger !== 'undefined' ? logger.error?.(...a) : console.error(...a)),
  debug: (...a) => (typeof logger !== 'undefined' ? logger.debug?.(...a) : null),
}

const DATA_DIR = path.join(pluginDir, 'data')
const TIMER_FILE = path.join(DATA_DIR, 'resin_timer.json')

/**
 * Node 的 setTimeout 超过 2^31-1 毫秒会溢出并「立即触发」，
 * 所以超长延时要分段续挂（见 arm）。24.8 天，质变仪最长 7 天，纯防御。
 */
const MAX_TIMEOUT = 2 ** 31 - 1

/** 重启时发现已过期：12 小时内的补发一次，更久的丢弃（等下次查询重算） */
const OVERDUE_GRACE_MS = 12 * 60 * 60 * 1000

/** 记录保鲜期：7 天没被任何一次查询更新过就清掉 */
const RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 发送失败后的重试间隔与次数上限。
 * 最典型的失败是「重启补发」：scheduleTimers() 在插件构造期就跑，那时适配器还没连上，
 * Bot 还是 undefined（日志时序：挂定时器 → 插件加载完 → 适配器连接，中间差好几秒）。
 * 这种失败不能把提醒标成 fired 吞掉，得留着等 Bot 上线。
 * 首次重试给 15 秒（适配器通常 10 秒内连上），之后退回 60 秒，避免真失败时刷屏。
 */
const RETRY_FIRST_MS = 15 * 1000
const RETRY_DELAY_MS = 60 * 1000
const MAX_RETRY = 5

/** 两种提醒类型（存储键名） */
const TYPES = ['transformer', 'homeCoin']

/**
 * 到点复核不通过时的重挂间隔下限。
 * 复核发现「服务器说该满了、实际没满」时按服务器新给的倒计时重挂，
 * 但绝不允许它低于这个值 —— 万一服务端返回 0/极小值，60 秒一轮会把
 * dailyNote 打到 1034 风控上，取 5 分钟兜底。
 */
const DEFER_MIN_MS = 5 * 60 * 1000
/**
 * 复核连续不通过多少次后转入长退避。
 *
 * ⚠️ 是「退避」不是「放弃」：早期写成标 fired 收场，那样会永久吞掉提醒 ——
 * 洞天宝钱要 46 小时才满，复核当然连不通过几十次，标 fired 之后
 * mergeDeadline 见 fired 就保持 fired，真满的那一刻也不会再通知了。
 * 现在改成把 dueAt 推到 DEFER_BACKOFF_MS 之后并清零计数，状态仍是 armed，
 * 于是它低频地一直盯着，真满了照样发。
 */
const MAX_DEFER = 6
/** 长退避间隔（复核反复拿不到有效倒计时时用） */
const DEFER_BACKOFF_MS = 2 * 60 * 60 * 1000

/** 热重载会重新求值整个模块；状态按插件目录共享，不能每一代各挂一套定时器。 */
const RUNTIME_KEY = Symbol.for('xhh-TL.resinTimer')
const runtimes = globalThis[RUNTIME_KEY] || (globalThis[RUNTIME_KEY] = new Map())
let runtime = runtimes.get(pluginDir)
if (!runtime) {
  runtime = { store: null, timers: new Map(), inflight: new Set(), retries: new Map(), generation: null, resume: null }
  runtimes.set(pluginDir, runtime)
}
const GENERATION = Symbol()
const isCurrentGeneration = () => runtime.generation === GENERATION
/** 已挂的定时器：`${game}:${uid}:${type}` → Timeout */
const _timers = runtime.timers
/** 重试预约也跨代保存，热重载清定时器后仍能恢复剩余退避时间。 */
const _retries = runtime.retries || (runtime.retries = new Map())
/**
 * 正在投递中的提醒（fire 已开始、还没落盘 fired）。
 * 跨代共享：新一代不能抢发旧一代已经开始投递的提醒。
 */
const _inflight = runtime.inflight
/** 新一代主动接管，不依赖宿主是否会调用该 app 的 onUnload。 */
clearAllTimers()
runtime.generation = GENERATION
runtime.resume = (game, uid, type, delay) => {
  if (delay !== undefined && enabled() && hasTargets(game, uid)) arm(game, uid, type, delay, true)
  else refreshUidTimers(game, uid)
}
/** 由 resinPush 注册：targets 同步反查订阅者，send 异步发送，verify 到点复核 */
let _hooks = { targets: null, send: null, verify: null }

// ============ 存储 ============

function loadStore() {
  if (runtime.store) return runtime.store
  try {
    if (fs.existsSync(TIMER_FILE)) {
      runtime.store = JSON.parse(fs.readFileSync(TIMER_FILE, 'utf8')) || {}
    } else {
      runtime.store = {}
    }
  } catch (err) {
    log.error(`[xhh-TL][resinTimer] 读取 ${TIMER_FILE} 失败: ${err.message}`)
    runtime.store = {}
  }
  if (!runtime.store.gs) runtime.store.gs = {}
  return runtime.store
}

function saveStore(store = runtime.store) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(TIMER_FILE, JSON.stringify(store, null, 2))
  } catch (err) {
    log.error(`[xhh-TL][resinTimer] 保存失败: ${err.message}`)
  }
}

// ============ 快照解析 ============

/**
 * 参量质变仪：从快照算出到期信息。
 * 只认带秒数的原始结构 —— 30 分钟缓存视图（transformerView）没有秒数，
 * 只能判「已可用」，绝不能用它去覆盖已算好的 dueAt。
 * @returns {{kind:'due', dueAt:number}|{kind:'ready'}|null} null = 本次快照没这个信息
 */
function readTransformerDeadline(data, now) {
  const raw = data?.transformer
  if (raw && typeof raw === 'object') {
    if (raw.obtained === false) return null // 尚未获得，没有「到期」概念
    const rt = raw.recovery_time
    if (rt && typeof rt === 'object') {
      const sec =
        (((Number(rt.Day) || 0) * 24 + (Number(rt.Hour) || 0)) * 60 + (Number(rt.Minute) || 0)) * 60 +
        (Number(rt.Second) || 0)
      if (rt.reached || sec <= 0) return { kind: 'ready' }
      return { kind: 'due', dueAt: now + sec * 1000 }
    }
    if (raw.reached) return { kind: 'ready' }
    // 旧结构：rec_time 是绝对时刻串 "YYYY-MM-DD HH:mm:ss"（补 T 后按本地时区解析）
    const str = String(raw.rec_time || '')
    const t = new Date(str.replace(' ', 'T')).getTime()
    if (Number.isFinite(t)) {
      return t <= now ? { kind: 'ready' } : { kind: 'due', dueAt: t }
    }
  }
  // 只有归一视图（缓存命中，无秒数）：只能判「已可用」
  if (data?.transformerView?.ok === true) return { kind: 'ready' }
  return null
}

/**
 * 洞天宝钱：满了才提醒。
 *
 * 判据只有 `cur >= max` 这一条 —— 见下面 sec 的坑，别拿倒计时当满。
 *
 * home_coin_recovery_time 是**字符串**剩余秒（实测 dailyNote 返回 "167286"），
 * 要 Number 强转，且它**确实**是「按理论产出速率算的距满秒数」：
 * 实测 1410 个 ÷ 46.47 小时 = 30.3 个/小时，两次采样都吻合。
 *
 * ⚠️⚠️ 但它会和实际库存脱钩，绝不能当成「到点就满了」：
 * 2026-09-30 实测同一账号，cur 卡在 990/2400 五十分钟纹丝不动，
 * 而 sec 老老实实每秒 -1（167286 → 166020）。即「倒计时在走、宝钱没涨」——
 * 米游社按理论速率倒计时，实际产出是另一回事（洞天产出停滞时就这样）。
 * 那时 sec 归零只代表「一个理论周期结束」，不代表攒满，据此推送就是假提醒
 * （04:08:32 那条「洞天宝钱已经满啦」正是这么来的，而它当时只有 990/2400，
 * 用户 04:10:44 自己一查就能戳穿）。
 *
 * 所以 sec 仍然用来估个「大概什么时候到点」（免得空转轮询），
 * 但那个时刻只是**复核预约**：到点由 resinPush.verify 重查真身，
 * cur >= max 才真发（见 fire 里的 _hooks.verify）。
 *
 * 另一个变量：此字段是字符串，实测有值；widget 接口不返回它 → 返回 null，
 * 等下次走 dailyNote 的查询，不猜速率。
 */
function readHomeCoinDeadline(data, now) {
  const cur = Number(data?.current_home_coin)
  const max = Number(data?.max_home_coin)
  if (!Number.isFinite(cur) || !Number.isFinite(max) || max <= 0) return null
  if (cur >= max) return { kind: 'ready' }
  const sec = Number(data?.home_coin_recovery_time)
  if (!Number.isFinite(sec) || sec <= 0) return null
  return { kind: 'due', dueAt: now + sec * 1000 }
}

/**
 * armed / fired 翻转的唯一出口。
 * @param {object|undefined} prev 上次的状态 { dueAt, state, notifiedAt }
 * @param {{kind:'due',dueAt:number}|{kind:'ready'}} info 本次快照算出的信息
 */
function mergeDeadline(prev, info, now) {
  if (info.kind === 'ready') {
    // ⚠️ 顺序要紧：armed 必须整体处理掉，不能只处理 dueAt 在未来的那种。
    // armed 且 dueAt 已过 = 「已到期、正在投递或正在重试」——这段窗口里 fire() 还没落盘
    // fired，绝不能动它。原先漏了这一支，它会掉进下面的「静默置 fired」分支，
    // 于是重试中的提醒被一次并发查询（用户发指令，或 10 分钟 cron 命中缓存视图）取消，
    // fire() 开头 `state !== 'armed'` 直接 return → 提醒永久丢失。
    if (prev?.state === 'armed') {
      // 已挂过未来时刻、数据却说到期了（快到了 / 时钟抖动）→ 提前到当下，别丢这次提醒。
      // 这是同一轮提醒的延续，attempt 要接着数，不能当成新周期清零。
      return prev.dueAt > now
        ? { dueAt: now, state: 'armed', notifiedAt: prev.notifiedAt || 0, attempt: prev.attempt || 0 }
        : prev
    }
    // 提醒过、用户还没用掉 → 保持 fired，不重复打扰
    if (prev?.state === 'fired') return prev
    // 新记录且查询时就已经满/已可用 → 静默（用户刚在图上看见了，不该立刻被 @）
    return { dueAt: 0, state: 'fired', notifiedAt: now }
  }
  // 出现新的未来到期时刻 = 用户用掉了，重新武装
  if (prev?.state === 'fired') {
    return { dueAt: info.dueAt, state: 'armed', notifiedAt: prev.notifiedAt || 0 }
  }
  // ⚠️ 这里返回的是**全新对象**，必须把 attempt / defer 显式带过来。
  // 它们分别记着「发送失败重试了几次」「到点复核没通过几次」，重挂时要接着数：
  // 每次查询都会走到这行（用户发指令、10 分钟 cron 命中缓存），漏带就等于
  // 每轮把计数清零 → 退避形同虚设、复核永远攒不到上限，无限重试。
  return {
    dueAt: info.dueAt,
    state: 'armed',
    notifiedAt: 0,
    attempt: prev?.attempt || 0,
    defer: prev?.defer || 0,
  }
}

// ============ 定时器 ============

function timerKey(game, uid, type) {
  return `${game}:${uid}:${type}`
}

function clearTimer(game, uid, type) {
  const key = timerKey(game, uid, type)
  const id = _timers.get(key)
  if (id) {
    clearTimeout(id)
    _timers.delete(key)
  }
}

function clearAllTimers() {
  for (const id of _timers.values()) clearTimeout(id)
  _timers.clear()
}

/** 该账号有没有人订阅（没有就不空转，等订阅了 scheduleTimers 会重挂） */
function hasTargets(game, uid) {
  try {
    return !!_hooks.targets?.(game, uid)?.length
  } catch (err) {
    log.debug(`[xhh-TL][resinTimer] targets 查询失败: ${err?.message}`)
    return false
  }
}

function enabled() {
  const cfg = config()
  return cfg.resin_timer_enable !== false && cfg.resin_push_enable !== false
}

/**
 * 挂一个定时器。超 MAX_TIMEOUT 的延时分段续挂
 * （Node 超过 2^31-1ms 会溢出立即触发，不能直接 setTimeout）。
 *
 * ⚠️ 正在投递（fire 的渲染+发送，实测 1.4~3.2 秒）时直接返回，不重挂。
 * 那段时间里 state 还是 armed、dueAt 已过，而 _timers 里的 id 在回调第一行就删了，
 * 没有这层保护的话任何 arm()/scheduleTimers() 都会再挂一个 → 同一人收到 2~3 条重复推送。
 * 重试次数存在记录的 st.attempt 里，不从参数传（外部调用点漏传会让计数归零、永不忍弃）。
 *
 * @param {boolean} force 重试场景用：那时 _inflight 还没释放（在 fire 的 finally 里），
 *                        必须绕过自己的锁，否则重试挂不上、一次失败就永不重试
 */
function arm(game, uid, type, delay, force = false) {
  if (!isCurrentGeneration()) return
  const key = timerKey(game, uid, type)
  if (!force && _inflight.has(key)) return
  clearTimer(game, uid, type)
  const wait = Math.max(1, Math.min(Number(delay) || 0, MAX_TIMEOUT))
  const id = setTimeout(() => {
    if (!isCurrentGeneration() || _timers.get(key) !== id) return
    _timers.delete(key)
    const st = loadStore()?.[game]?.[uid]?.[type]
    // 分段醒来：还没到点就续挂；状态已被改（用户用掉/关订阅）则不再管
    if (!st || st.state !== 'armed') return
    const left = st.dueAt - Date.now()
    if (left > 1000) return arm(game, uid, type, left)
    // fire 是 async 且内部已捕获发送错误，这里再兜一层防 unhandled rejection
    fire(game, uid, type).catch((err) =>
      log.error(`[xhh-TL][resinTimer] 提醒处理异常 ${game}/${uid}/${type}: ${err?.message}`),
    )
  }, wait)
  _timers.set(key, id)
}

/**
 * 把一条提醒标成「已提醒」并落盘。
 * armed/fired 的写入点统一走这里，别在别处手改 state（容易漏 updatedAt）。
 * 注意 loadStore() 返回的是内存缓存引用，重复调用拿到的是同一份，不必反复取。
 */
function markFired(game, uid, type) {
  const store = loadStore()
  const st = store?.[game]?.[uid]?.[type]
  if (!st) return
  st.state = 'fired'
  st.notifiedAt = Date.now()
  // 重试计数归零：这一轮已了结，下次重新武装（用户用掉后）从 0 开始数
  st.attempt = 0
  st.defer = 0
  _retries.delete(timerKey(game, uid, type))
  store[game][uid].updatedAt = Date.now()
  saveStore(store)
}

/**
 * 到点复核：问一次真实状态，确认「确实到点了」才允许推送。
 *
 * 为什么必须有这一步：dueAt 是照 dailyNote 的**倒计时字段**算的，
 * 而洞天宝钱的倒计时会和实际库存脱钩（见 readHomeCoinDeadline 的注释）。
 * 没有复核 = 拿一个会撒谎的字段决定要不要 @ 人。
 *
 * 三种返回：
 *   { ready: true }  确实到点了 → 正常发送
 *   { ready: false, dueAt, snap }  还没到 → defer 重挂（dueAt 为下次预约时刻）
 *   null             连兜底快照都没有、判不了 → 放行发送
 *
 * ⚠️ null 是最后兜底：verifyReminder 内部已经做了两层判断（接口真身 →
 * 记录里的旧快照），只有两层都拿不到信息才走到这里。放行是为了「宁可偶尔
 * 误报，也别把真提醒永久吞掉」——但这个口子已经收得很窄了。
 */
async function verifyDeadline({ game, uid, type }) {
  if (!_hooks.verify) return null
  try {
    const v = await _hooks.verify({ game, uid, type })
    if (!v || typeof v !== 'object') return null
    return v.ready === true ? { ready: true } : { ready: false, dueAt: v.dueAt, snap: v.snap }
  } catch (err) {
    log.debug?.(`[xhh-TL][resinTimer] 复核失败 ${game}/${uid}/${type}: ${err?.message}`)
    return null
  }
}

/**
 * 复核不通过：这一轮不发，按服务器新给的倒计时重挂等下一次。
 *
 * ⚠️ 这段在 fire 的 try 里、_inflight 还没释放（在 finally 里），
 * 必须 force 绕过自己的锁，否则重挂不上、这条提醒就此断掉。
 *
 * 连续 defer 次数存在 st.defer 里（不靠参数传，和 attempt 同理）：
 * 攒够 MAX_DEFER 次就转长退避（状态**保持 armed**），防的是坏数据把定时器
 * 变成高频轮询器 —— 但绝不标 fired，那样真到满的那一刻就永远不通知了。
 */
function defer(game, uid, type, verdict) {
  const store = loadStore()
  const st = store?.[game]?.[uid]?.[type]
  if (!st || st.state !== 'armed') return

  let n = Number(st.defer || 0) + 1
  let wait
  const raw = Number.isFinite(Number(verdict?.dueAt)) ? Number(verdict.dueAt) : 0

  if (raw > Date.now()) {
    // 服务器给了明确的下次到期时刻（宝钱有 sec，能算出 46 小时后）→ 就按它约，
    // 保底 DEFER_MIN_MS 防「服务器给个极小值导致高频轮询」。这是最常见的一条：
    // 复核时还没满，sec 会重新给出一个完整的到满时间，于是下次到点再看。
    wait = Math.max(raw - Date.now(), DEFER_MIN_MS)
    n = 0 // 有明确时刻可循，不算「反复拿不到信息」，计数归零
  } else if (n >= MAX_DEFER) {
    // 反复拿不到有效的下次时刻（比如质变仪的 view 只有「N天后」文本、没有秒数，
    // 或者服务端一直给 0）→ 转低频长退避继续盯，**不放弃**
    wait = DEFER_BACKOFF_MS
    n = 0
    log.debug?.(`[xhh-TL][resinTimer] ${game}/${uid}/${type} 复核反复无结果，转 ${DEFER_BACKOFF_MS / 3600000} 小时长退避`)
  } else {
    wait = DEFER_MIN_MS
  }

  st.defer = n
  st.attempt = 0
  _retries.delete(timerKey(game, uid, type))
  // 复核拿到的新快照顺手写回：下次到点出图/再复核都用它，别拿着过期数据反复算
  if (verdict?.snap && typeof verdict.snap === 'object') {
    store[game][uid].snap = { ...(store[game][uid].snap || {}), ...verdict.snap }
  }
  store[game][uid].updatedAt = Date.now()
  // dueAt 同步推到新时刻：timerStats 展示、以及下次 scheduleTimers 认它
  st.dueAt = Date.now() + wait
  saveStore(store)

  log.debug?.(
    `[xhh-TL][resinTimer] ${game}/${uid}/${type} 复核未到点，${Math.round(wait / 1000)} 秒后再看`,
  )
  arm(game, uid, type, wait, true)
}

/**
 * 到点：发送成功才落盘 fired。
 *
 * ⚠️ 顺序不能反。原先写成「先落盘 fired 再发送」，一旦发送失败这条提醒就**永久丢了**
 * —— 重启补发必然踩中：scheduleTimers() 在插件构造期跑，那时适配器还没连上、
 * Bot 是 undefined，发送直接抛错，而 state 已经变成 fired 不会再重试。
 * 代价是「发送成功后、落盘前」崩溃会重复提醒一次，概率极低且比漏发温和。
 *
 * 重试次数存在记录的 `st.attempt`（不靠参数传）：arm() 有多个外部调用点
 * （scheduleTimers / refreshUidTimers / recordResinTimer），漏传就会让计数归零、
 * 永不忍弃，每 10 分钟白渲染一张图。存进记录后，任何路径重挂都能接着数。
 */
async function fire(game, uid, type) {
  if (!isCurrentGeneration()) return
  const key = timerKey(game, uid, type)
  // 已在投递中就别重复发（arm 的入口保护 + 这里兜一道，防同 tick 内的并发调用）
  if (_inflight.has(key)) return
  const store = loadStore()
  const st = store?.[game]?.[uid]?.[type]
  if (!st || st.state !== 'armed') return

  const targets = hasTargets(game, uid) ? _hooks.targets(game, uid) || [] : []
  // 出图用的精简快照（记录里存的那份，不重查接口）
  let item = store[game][uid].snap || { uid: String(uid) }

  // 没有订阅者：直接标 fired，不必重试（用户可能刚关掉推送）
  if (!targets.length) {
    markFired(game, uid, type)
    return
  }

  _inflight.add(key)
  let retryDelay
  try {
    // 到点复核：**发送前必须确认真的到了**。
    // 定时器的 dueAt 是照 dailyNote 的倒计时算的，而那个倒计时会撒谎 ——
    // home_coin_recovery_time 按理论速率走，实际库存可能停滞（2026-09-30 实测
    // 990/2400 卡住不动、倒计时却一秒不差地走向归零），照它推送就是「没满却说满了」。
    // 复核走的是和用户查询同源的接口，cur>=max 才算数。
    //
    // 复核不通过 → 按服务器新给的倒计时重挂，不推送、不落盘 fired（下一次到点再复核）。
    // 复核本身失败（接口挂了/没凭证）→ 放行发送：宁可偶尔误报，也别把真提醒吞了。
    const verdict = await verifyDeadline({ game, uid, type })
    // 复核期间可能被热重载接管；还没发送就交给新一代重新处理。
    if (!isCurrentGeneration()) return
    if (verdict?.ready === false) {
      defer(game, uid, type, verdict)
      return
    }
    // 复核通过时拿到的是**刚查回来的**真身，比记录里那份旧快照准，优先用它出图
    // （同时写回记录，别让后续展示继续用过期数据）
    if (verdict?.snap && typeof verdict.snap === 'object') {
      item = { ...item, ...verdict.snap }
      const s = loadStore()
      if (s?.[game]?.[uid]) {
        s[game][uid].snap = { ...(s[game][uid].snap || {}), ...verdict.snap }
        s[game][uid].updatedAt = Date.now()
        saveStore(s)
      }
    }

    await _hooks.send?.({ game, uid, type, targets, item })
    // 已经开始的投递允许收尾，但落盘必须仍在跨代锁内，新一代才不会重复发。
    if (loadStore()?.[game]?.[uid]?.[type]?.state === 'armed') markFired(game, uid, type)
  } catch (err) {
    const n = Number(st.attempt || 0) + 1
    // 重新取一次状态：这期间可能已被新一轮查询改写（用户用掉了 → 重新 armed）
    const cur = loadStore()?.[game]?.[uid]?.[type]
    if (n <= MAX_RETRY && cur?.state === 'armed') {
      const delay = n === 1 ? RETRY_FIRST_MS : RETRY_DELAY_MS
      cur.attempt = n
      _retries.set(key, Date.now() + delay)
      const s = loadStore()
      s[game][uid].updatedAt = Date.now()
      saveStore(s)
      log.error(
        `[xhh-TL][resinTimer] 提醒发送失败 ${game}/${uid}/${type}（第 ${n} 次），` +
          `${delay / 1000} 秒后重试: ${err?.message}`,
      )
      // ⚠️ 这时 _inflight 还没释放（在 finally 里），必须 force 绕过自己的锁，
      // 否则重试定时器挂不上，一次失败就再也不重试了。
      retryDelay = delay
      arm(game, uid, type, delay, true)
    } else {
      log.error(
        `[xhh-TL][resinTimer] 提醒发送失败 ${game}/${uid}/${type}，放弃: ${err?.message}`,
      )
      if (cur?.state === 'armed') markFired(game, uid, type)
    }
    return
  } finally {
    _inflight.delete(key)
    // 接管时跳过了 inflight 的提醒：复核取消则重挂，投递失败则保留重试退避。
    if (!isCurrentGeneration()) runtime.resume?.(game, uid, type, retryDelay)
  }
}

/**
 * 复核用：拿一份**刚查到的**快照，判断某类提醒此刻是否真的可发。
 *
 * 解析逻辑必须和 recordResinTimer 同源 —— 两边各写一套必然漂移，
 * 到时候「记的时候算一个数、复核的时候算另一个数」，永远发不出去。
 *
 * @returns {{ready:boolean, dueAt:number|null, snap:object}|null}
 *   null = 这份快照里没有该类提醒的信息（比如 widget 不返回质变仪，
 *          或是还没获得的账号）→ 调用方按「复核不了」处理，放行发送
 */
export function evaluateSnapshot(game, uid, data) {
  if (game !== 'gs' || !data || typeof data !== 'object') return null
  const now = Date.now()
  const out = {}

  // 洞天宝钱：判据只有 cur >= max，**不能复用 readHomeCoinDeadline**。
  // 那个函数在 sec 无效时返回 null（用来表示「算不出到期时刻，别挂定时器」），
  // 但复核场景下 null 会被当成「这个快照没这类信息」→ 上层放行发送 ——
  // 而 sec 归零恰恰就是假推送的触发条件（米游社倒计时走完、实际没满）。
  // 所以这里独立判定：没满就 ready:false，算不算得出下次时刻是另一回事。
  const hcCur = Number(data.current_home_coin)
  const hcMax = Number(data.max_home_coin)
  if (Number.isFinite(hcCur) && Number.isFinite(hcMax) && hcMax > 0) {
    if (hcCur >= hcMax) {
      out.homeCoin = { ready: true, dueAt: null }
    } else {
      const sec = Number(data.home_coin_recovery_time)
      out.homeCoin = {
        ready: false,
        // sec 有效就按它约下一次；无效（0/缺失）给 null，交给 defer 用兜底间隔
        dueAt: Number.isFinite(sec) && sec > 0 ? now + sec * 1000 : null,
      }
    }
  }

  // 参量质变仪：widget 快照不带这个字段 → 整条跳过（下面的 null 语义：
  // 复核不了就放行，别把能发的提醒拦死）。有字段时按冷却是否结束判。
  const tf = readTransformerDeadline(data, now)
  if (tf) {
    out.transformer = tf.kind === 'ready'
      ? { ready: true, dueAt: null }
      : { ready: false, dueAt: tf.dueAt }
  } else if (data?.transformerView?.ok === false) {
    // ⚠️ 只有归一视图、没有原始结构时（记录里存的快照就是这样），
    // readTransformerDeadline 返回 null。但 null 在这里的语义是「没信息、放行」，
    // 而 view.ok===false 是**明确说还在冷却**（文案就写着「4天后可再次使用」）——
    // 拿它当「没信息」放行，就是「没冷却完却 @ 人说能用了」，与宝钱那个 bug 同源。
    // view 里只有「N天后」文本、没有秒数，算不出精确时刻 → dueAt 给 null，
    // 交给 defer 用兜底间隔接着等。
    out.transformer = { ready: false, dueAt: null }
  }

  if (!Object.keys(out).length) return null
  out.snap = {
    uid: String(uid),
    current_home_coin: Number(data.current_home_coin) || 0,
    max_home_coin: Number(data.max_home_coin) || 0,
    home_coin_recovery_time: data.home_coin_recovery_time,
    transformer: data.transformer || null,
    transformerView: data.transformerView
      ? { ok: !!data.transformerView.ok, text: String(data.transformerView.text || '') }
      : null,
  }
  return out
}

// ============ 对外 API ============

/** resinPush 构造时注册「发给谁 / 怎么发 / 到点怎么复核」 */
export function registerReminderHooks(hooks = {}) {
  if (!isCurrentGeneration()) return
  _hooks = {
    targets: hooks.targets || null,
    send: hooks.send || null,
    verify: hooks.verify || null,
  }
}

/**
 * TL.finishNote 每次拿到 gs 快照后调用。
 * 解析 → 更新记录 → 落盘 → 挂定时器（就是「首次获取之后开个定时器」）。
 */
export function recordResinTimer(game, uid, data) {
  if (!isCurrentGeneration()) return
  if (game !== 'gs' || !uid || !data || typeof data !== 'object') return
  if (!enabled()) return

  const now = Date.now()
  const tf = readTransformerDeadline(data, now)
  const hc = readHomeCoinDeadline(data, now)
  if (!tf && !hc) return

  const store = loadStore()
  const key = String(uid)
  const rec = store.gs[key] || (store.gs[key] = { uid: key, updatedAt: now })
  if (data._ownerSid) rec.sid = String(data._ownerSid)
  if (tf) rec.transformer = mergeDeadline(rec.transformer, tf, now)
  if (hc) rec.homeCoin = mergeDeadline(rec.homeCoin, hc, now)
  // 精简快照：到点要出提醒卡，但那时手上只有记录（不重查接口）。
  // 只存渲染用得上的几个字段，别把整个 data（含 expeditions 等）塞进来。
  // ⚠️ home_coin_recovery_time / transformer 这两个是给「到点复核没通过、
  // 要用新快照重算 dueAt」用的（见 defer）—— 缺了它们复核发现没满时
  // 算不出下一次预约时刻，定时器就断了。
  //
  // ⚠️ 合并写而不是整体替换：体力推送轮询走的是 widget，它**不返回**
  // home_coin_recovery_time 和 transformer（只认 dailyNote）。整体替换的话每轮
  // 轮询都会把上一次用户查询留下的好数据冲成 undefined，复核时就少一份参照。
  const prevSnap = rec.snap || {}
  const next = { ...prevSnap, uid: key }
  if (data.current_home_coin !== undefined) next.current_home_coin = Number(data.current_home_coin) || 0
  if (data.max_home_coin !== undefined) next.max_home_coin = Number(data.max_home_coin) || 0
  if (data.home_coin_recovery_time !== undefined) next.home_coin_recovery_time = data.home_coin_recovery_time
  if (data.transformer) next.transformer = data.transformer
  if (data.transformerView) {
    next.transformerView = { ok: !!data.transformerView.ok, text: String(data.transformerView.text || '') }
  }
  rec.snap = next
  rec.updatedAt = now
  saveStore(store)
  for (const type of TYPES) {
    if (Number(rec[type]?.attempt || 0) === 0) _retries.delete(timerKey(game, key, type))
  }

  // 立刻挂/换定时器（到期时刻可能刚被刷新）
  for (const type of TYPES) {
    const st = rec[type]
    if (!st) continue
    if (st.state === 'armed' && hasTargets(game, key)) {
      // 重试中的提醒继续等原来的退避预约，查询不能把它提前成即时发送。
      const retryAt = _retries.get(timerKey(game, key, type))
      const left = retryAt !== undefined ? retryAt - Date.now() : st.dueAt - Date.now()
      // ⚠️ left <= 0 也要挂（延时 0）：mergeDeadline 可能刚把 dueAt 提前到「当下」
      // （数据说已到期、旧记录还是未来时刻），这时不补挂的话得等原来那个未来时刻的
      // 定时器醒来才会发，「提前」等于没生效，最长拖到下一次 scheduleTimers。
      arm(game, key, type, left > 0 ? left : 0)
    } else {
      clearTimer(game, key, type)
    }
  }
}

/**
 * 重算全部定时器（幂等：先 clear 再 set）。
 * 调用时机：插件加载时（重启恢复）、订阅变更后、每轮 checkAll 收尾。
 */
export function scheduleTimers() {
  if (!isCurrentGeneration()) return
  if (!enabled()) {
    clearAllTimers()
    return
  }
  const store = loadStore()
  const now = Date.now()
  let armed = 0
  let dirty = false

  for (const game of Object.keys(store)) {
    for (const uid of Object.keys(store[game] || {})) {
      const rec = store[game][uid]
      if (!rec) continue
      // 陈旧记录清理
      if (now - (rec.updatedAt || 0) > RECORD_TTL_MS) {
        delete store[game][uid]
        for (const type of TYPES) clearTimer(game, uid, type)
        dirty = true
        continue
      }
      for (const type of TYPES) {
        const st = rec[type]
        if (!st || st.state !== 'armed' || !hasTargets(game, uid)) {
          clearTimer(game, uid, type)
          continue
        }
        const plan = shouldFireNow(st, now, timerKey(game, uid, type))
        if (plan.arm) {
          arm(game, uid, type, plan.delay)
          armed++
        } else if (plan.expired) {
          // 过期太久：丢弃，等下次查询重算
          st.state = 'fired'
          st.notifiedAt = now
          clearTimer(game, uid, type)
          dirty = true
        }
        // 其余情况（重试退避中）保持原样，退避定时器还在跑
      }
    }
  }

  if (dirty) saveStore(store)
  if (armed) log.info(`[xhh-TL][resinTimer] 已挂 ${armed} 个到期提醒`)
}

/**
 * 该不该由 scheduleTimers / refreshUidTimers 立刻补发（arm 延时 0）。
 *
 * 「已到期 + 有订阅者」不等于「该立刻重发」：重试链路里的记录 dueAt 早就过了，
 * 此刻它正等 15/60 秒的退避（st.attempt > 0）。这种要原样留着，让退避跑完，
 * 否则每轮 cron 都 arm(0) 立刻重发 → 退避形同虚设、失败时疯狂渲染。
 */
function shouldFireNow(st, now, key) {
  // 热重载会清旧 timeout，但不能丢重试预约；进程重启没预约时从首轮退避恢复。
  if (Number(st.attempt || 0) > 0) {
    if (!_retries.has(key)) {
      _retries.set(key, now + (Number(st.attempt) === 1 ? RETRY_FIRST_MS : RETRY_DELAY_MS))
    }
    return { arm: true, delay: Math.max(0, _retries.get(key) - now) }
  }
  if (st.dueAt > now) return { arm: true, delay: st.dueAt - now }
  if (st.dueAt > now - OVERDUE_GRACE_MS) return { arm: true, delay: 0 }
  return { arm: false, expired: true }
}

/** 单个 uid 重算（订阅变更后用，比全量轻） */
export function refreshUidTimers(game, uid) {
  if (!isCurrentGeneration()) return
  if (!enabled()) {
    clearTimer(game, uid, 'transformer')
    clearTimer(game, uid, 'homeCoin')
    return
  }
  const rec = loadStore()?.[game]?.[String(uid)]
  if (!rec) return
  const now = Date.now()
  for (const type of TYPES) {
    const st = rec[type]
    if (!st || st.state !== 'armed' || !hasTargets(game, String(uid))) {
      clearTimer(game, String(uid), type)
      continue
    }
    const plan = shouldFireNow(st, now, timerKey(game, uid, type))
    if (plan.arm) arm(game, String(uid), type, plan.delay)
  }
}

/** 供「体力推送列表」展示用：该 uid 的两个到期状态 */
export function timerStats(game, uid) {
  const rec = loadStore()?.[game]?.[String(uid || '')]
  if (!rec) return null
  const out = {}
  for (const type of TYPES) {
    const st = rec[type]
    if (st) out[type] = { dueAt: st.dueAt, state: st.state }
  }
  return Object.keys(out).length ? out : null
}

/**
 * 该 uid 上次查询留下的精简快照（原始数据，未判读）。
 * 给复核做兜底用：接口查不到时拿它判「满没满」，返回 null 表示没记录。
 */
export function timerSnapshot(game, uid) {
  const rec = loadStore()?.[game]?.[String(uid || '')]
  return rec?.snap || null
}

export default { registerReminderHooks, recordResinTimer, scheduleTimers, refreshUidTimers, timerStats, timerSnapshot, evaluateSnapshot }
