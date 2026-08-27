/**
 * 米游币社区任务客户端（原神 / 星铁 / 绝区零 版块）
 *
 * 这跟 signClient.js（游戏签到领原石）是两套东西，别混：
 *   signClient : api-takumi.mihoyo.com/event/luna/*  认证要 cookie_token  主体是游戏 UID
 *   本模块     : bbs-api.mihoyo.com 社区接口         认证要 stoken        主体是米游社账号 stuid
 *
 * 任务构成（做满一天约 +20~22 米游币/账号）：
 *   版块签到 → 浏览帖子 ×N → 点赞 ×N → 分享 ×1
 *
 * 移植自 xiaoyao-cvs-plugin，途中修掉了源实现两处问题：
 *   1) gids 混用：源码 bbsSign 传 `gids: forumId`，把「版块 id」当「游戏 id」用了。
 *      二者不同（原神 gids=2 但 forum_id=26），本模块分开存。
 *   2) DS2 签名体算错：源码 mihoyoApi.js:370 用 `board.forumid`，而该路径传进去的对象
 *      只有驼峰 `forumId`，故签名恒按 {"gids":null} 计算，与真实 body 不一致。
 *      本模块按真实 body 串签名。
 *
 * 另外源码对帖子列表 20 篇逐个「看帖+点赞」（40+ 请求）纯属浪费且易风控——
 * 官方日任务上限就是看帖 3~5、点赞 5、分享 1，本模块按需求数收敛（约 12~15 请求/账号）。
 *
 * 降风控沿用本插件既定做法（见 signClient.js 头注释）：稳定 device_id + 请求前 getFp 拿真指纹。
 */

import fs from 'fs'
import path from 'path'
import md5 from 'md5'
import YAML from 'yaml'
import fetch from 'node-fetch'
import LiteMysApi from './mysClient.js'
import { runBbsVerify } from './mysVerify.js'
import { cookiePart } from './auth.js'
import { createUser, getAliveMysIds, hasRuntimeBinding } from './userBind.js'
import { getDeletedMap, fingerprintStoken, removeDeleted } from './deletedCk.js'
import { getStokenCandidateFiles, config, resolveConfiguredPaths } from './pluginConfig.js'
import { withReadonlyDb, getSqliteDriver, sqliteUnavailableMessage } from './sqlite.js'

const log = {
  mark: (...a) => (typeof logger !== 'undefined' ? logger.mark(...a) : console.log(...a)),
  error: (...a) => (typeof logger !== 'undefined' ? logger.error(...a) : console.error(...a)),
  debug: (...a) => (typeof logger !== 'undefined' ? logger.debug?.(...a) : null),
}

const BBS_HOST = 'https://bbs-api.mihoyo.com'

/**
 * 盐与版本号必须成套，实测（2026-08）结论：
 *   - 源插件那套 2.70.1 + 老 K2/X6 已被服务端拒：GET 类返回 -100、POST 类返回 -10001。
 *   - 换成米游社 2.102.1 的盐后 GET 类全部通（查任务态 / 帖子列表 / 看帖 / 分享 retcode=0）。
 *   - POST 类（signIn）要用下面的 SALT_22：用它返回 1034（风控码，说明签名已过、进到业务层），
 *     用其它盐一律 -10001（签名本身被拒）。两者含义不同，别混。
 * 盐表取自 gsuid_core/gsuid_core/utils/api/mys/tools.py 的 _S['2.102.1']。
 */
const APP_VERSION = '2.102.1'
// GET 类 DS 用它
const SALT_K2 = 'lX8m5VO5at5JG7hR8hzqFwzyL5aB1tYo'
// POST 类 DS2 用它（gsuid 表里的 salt_id "22"）
const SALT_X6 = 't0qEgfub6cvueAPgR5m9aQWWVciEer7v'

/**
 * 版块表。gids = 游戏 id（签到用）；forumId = 版块 id（拉帖子用）。两者不可互换。
 * 注：mys.json 里绝区零 id 记的是 7，真实 gids 为 8。
 */
const FORUMS = {
  gs: { gids: 2, forumId: 26, name: '原神' },
  sr: { gids: 6, forumId: 52, name: '星铁' },
  zzz: { gids: 8, forumId: 57, name: '绝区零' },
}

// 每日任务需求数（按官方上限收敛，不做无谓请求）
const NEED_READ = 5
const NEED_VOTE = 5
const NEED_SHARE = 1

/** GET 类 DS：md5(salt=K2&t=&r=) —— r 为 6 位随机串 */
function getBbsDs() {
  const t = Math.round(Date.now() / 1000)
  let r = ''
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 6; i++) r += chars[Math.floor(Math.random() * chars.length)]
  return `${t},${r},${md5(`salt=${SALT_K2}&t=${t}&r=${r}`)}`
}

/** POST 类 DS2：md5(salt=X6&t=&r=&b=<body>&q=<query>) —— r 为 100001~200000 随机数 */
function getBbsDs2(body = '', query = '') {
  const t = Math.round(Date.now() / 1000)
  const r = Math.floor(Math.random() * 100000) + 100001
  return `${t},${r},${md5(`salt=${SALT_X6}&t=${t}&r=${r}&b=${body}&q=${query}`)}`
}

/**
 * bbs 请求 headers（app 端形态：client_type=2）
 * 传 ds2Body/ds2Query 走 DS2（POST），否则走 DS（GET）。
 *
 * device 可以是字符串（仅 device_id），也可以是 {id, fp, model, name} —— 后者用于
 * 复用 gsuid 库里持久化的真实设备信息（比现派生的更不容易被风控）。
 */
function buildHeaders(cookie, device, deviceFp, { ds2Body = null, ds2Query = '' } = {}) {
  const dev = typeof device === 'object' && device ? device : { id: device }
  const model = dev.model || 'Mi 10'
  const name = dev.name || `Xiaomi ${model}`
  return {
    Cookie: cookie,
    'x-rpc-channel': 'miyousheluodi',
    'x-rpc-device_id': String(dev.id || ''),
    'x-rpc-app_version': APP_VERSION,
    'x-rpc-device_model': model,
    'x-rpc-device_name': name,
    'x-rpc-client_type': '2',
    'x-rpc-sys_version': '12',
    'x-rpc-csm_source': 'myself',
    'x-rpc-device_fp': dev.fp || deviceFp || '38d7ee834d1e9',
    Referer: 'https://app.mihoyo.com',
    'User-Agent': `Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.133 Mobile Safari/537.36 miHoYoBBS/${APP_VERSION}`,
    DS: ds2Body === null ? getBbsDs() : getBbsDs2(ds2Body, ds2Query),
  }
}

/** 撞验证码判定：源实现只看 1034，这里把同族风控码一并纳入 */
function isCaptcha(res) {
  const rc = Number(res?.retcode)
  return !!(res?.data?.challenge || res?.data?.gt || [1034, 5003, 10035, 10041].includes(rc))
}

/**
 * 登录失效判定。
 * 注意 -10001 不在此列：实测它是 "invalid request"，即 DS 签名被服务端拒，
 * 与 stoken 是否有效无关（同一有效 stoken 换个盐就能通）。混进来会把签名问题
 * 误报成「stoken 失效」并中断整个账号，所以单独用 isBadSign 判。
 */
function isExpired(res) {
  return [-100, -101, 10001].includes(Number(res?.retcode))
}

/** 签名被拒（盐/版本不匹配），不是凭证问题 */
function isBadSign(res) {
  return Number(res?.retcode) === -10001
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 请求间随机停顿，降低风控 */
function jitter(min = 1000, max = 3000) {
  return sleep(min + Math.floor(Math.random() * (max - min)))
}

/**
 * DS 走 GET 式（md5(salt&t&r)），DS2 走 POST 式（额外带 b=<body>&q=<query>）。
 * 本模块的 GET 接口把参数直接拼在 URL 上、DS 不参与签名，故这里只有 POST 需要 body。
 */
async function req(url, { cookie, device, deviceFp, body = null }) {
  const isPost = body !== null
  const bodyStr = isPost ? JSON.stringify(body) : ''
  const headers = buildHeaders(cookie, device, deviceFp, {
    ds2Body: isPost ? bodyStr : null,
  })
  const param = { method: isPost ? 'POST' : 'GET', headers, timeout: 12000 }
  if (isPost) {
    param.body = bodyStr
    headers['Content-Type'] = 'application/json;charset=UTF-8'
  }
  try {
    const res = await fetch(url, param)
    if (!res.ok) {
      log.debug(`[xhh-TL][米游币] HTTP ${res.status} ${url}`)
      return false
    }
    return await res.json()
  } catch (err) {
    log.debug(`[xhh-TL][米游币] 请求异常 ${url}: ${err?.message}`)
    return false
  }
}

// ============ 单接口封装 ============

/** 查米游币余额与任务态 */
export async function queryMissions(cookie, device, deviceFp) {
  const res = await req(`${BBS_HOST}/apihub/sapi/getUserMissionsState`, {
    cookie,
    device,
    deviceFp,
  })
  if (!res || !res.data) return { ok: false, res }
  return {
    ok: true,
    total: Number(res.data.total_points) || 0,
    canGet: Number(res.data.can_get_points) || 0,
    states: res.data.states || [],
    res,
  }
}

/** 版块签到（body 用 gids，非 forumId） */
async function signForum(cookie, device, deviceFp, gids) {
  return req(`${BBS_HOST}/apihub/app/api/signIn`, {
    cookie,
    device,
    deviceFp,
    body: { gids: Number(gids) },
  })
}

/** 拉版块帖子列表 */
async function getPostList(cookie, device, deviceFp, forumId) {
  const query = `forum_id=${forumId}&is_good=false&is_hot=false&page_size=20&sort_type=1`
  const res = await req(`${BBS_HOST}/post/api/getForumPostList?${query}`, {
    cookie,
    device,
    deviceFp,
  })
  const list = res?.data?.list || []
  return list.map((x) => x?.post?.post_id).filter(Boolean)
}

/** 浏览帖子 */
async function readPost(cookie, device, deviceFp, postId) {
  return req(`${BBS_HOST}/post/api/getPostFull?post_id=${postId}`, { cookie, device, deviceFp })
}

/** 点赞 */
async function votePost(cookie, device, deviceFp, postId) {
  return req(`${BBS_HOST}/apihub/sapi/upvotePost`, {
    cookie,
    device,
    deviceFp,
    body: { post_id: String(postId), is_cancel: false },
  })
}

/** 分享 */
async function sharePost(cookie, device, deviceFp, postId) {
  return req(`${BBS_HOST}/apihub/api/getShareConf?entity_id=${postId}&entity_type=1`, {
    cookie,
    device,
    deviceFp,
  })
}

/**
 * 解析账号自带的设备信息。gsuid 库里每个账号都存了注册过的 device_id / fp / device_info，
 * 直接复用比现派生一套更不容易触发风控；没有则退回 md5(stuid) 派生 + 现取 fp。
 */
async function resolveDevice(account) {
  const { stuid, cookie, device_id: devId, fp, device_info: devInfo } = account
  if (devId) {
    const parts = String(devInfo || '').split('/')
    return { id: devId, fp: fp || '', model: parts[1] || 'Mi 10', name: parts[0] && parts[1] ? `${parts[0]} ${parts[1]}` : '' }
  }
  const id = bbsDeviceId(stuid)
  return { id, fp: await fetchDeviceFp(stuid, cookie, id) }
}

/** 由 stuid 稳定派生 device_id（与 mysClient.deviceId 同风格，保证过码/请求同设备） */
export function bbsDeviceId(stuid) {
  return md5(String(stuid)).substring(0, 16).toUpperCase()
}

/** 取真 device_fp（复用 LiteMysApi 的 getFp 流程） */
async function fetchDeviceFp(stuid, cookie, device) {
  try {
    const api = new LiteMysApi(stuid, cookie, { game: 'gs', device, log: false })
    const fpRes = await api.getData('getFp', {
      seed_id: md5(String(stuid) + Date.now()).slice(0, 16),
      Getfp: true,
    })
    return fpRes?.data?.device_fp || ''
  } catch (err) {
    log.debug(`[xhh-TL][米游币] getFp 失败 ${stuid}: ${err?.message}`)
    return ''
  }
}

/**
 * 展开一个账号的全部候选凭证（主 + alts），每份带自己的设备信息。
 */
function accountCandidates(account) {
  const list = [{ ...account, alts: undefined }]
  for (const alt of account.alts || []) list.push({ ...account, ...alt, alts: undefined })
  return list
}

/**
 * 逐个候选凭证试到能通的那个。
 *
 * 同一 stuid 可能同时存在多份 stoken（gsuid 库一份、扫码写进 yaml 一份），且两份未必同时有效。
 * 早先按「来源优先级取第一份」，结果旧 stoken 会把刚扫码的新 stoken 挡死，误报成失效。
 * 这里不认「第一份」，认「第一份能通的」。
 *
 * 只在 isExpired（凭证问题）时才换下一份；签名被拒/网络异常换凭证也没用，直接停。
 */
async function pickLiveCredential(account) {
  const cands = accountCandidates(account)
  let last = null
  for (let i = 0; i < cands.length; i++) {
    const cand = cands[i]
    const device = await resolveDevice(cand)
    const missions = await queryMissions(cand.cookie, device, device.fp)
    if (missions.ok) {
      if (i > 0) log.mark(`[xhh-TL][米游币] ${account.stuid} 第 ${i + 1} 份 stoken 可用（前面的已失效）`)
      return { cand, device, missions }
    }
    last = { cand, device, missions }
    if (!isExpired(missions.res)) break
    if (i < cands.length - 1) await jitter(500, 1200)
  }
  return last
}

/**
 * bbs 拒了之后，再问一次 passport，用来区分两种完全不同的失败：
 *
 *   passport 也拒 → stoken 本体过期，重新扫码就能修
 *   passport 却通 → stoken 是活的，但作用域不对。作用域由建码时的 x-rpc-app_id 决定：
 *                   ddxf5dufpuyo（HYP 启动器）/ app_id=2（游戏码）签出的 stoken 能换
 *                   cookie_token、能查体力，社区接口一律 -100；只有 bll8iq97cem8
 *                   （米游社 App，xiaoyao-cvs-plugin 走的就是这个）才带社区作用域。
 *                   2026-08 实测：TRSS-Plugin 抢走 #扫码登录 用的是前者，故米游币全灭；
 *                   移除后落回 xiaoyao 重扫即恢复。
 *
 * 两者提示语不同，否则用户会反复扫同一个码。查询失败不影响判定，按「过期」保守处理。
 *
 * 接口按 stoken 版本分流，混用会让复核恒失败：
 *   v1（stoken=...）  : api-takumi /auth/api/getCookieAccountInfoBySToken?stoken=&uid=
 *   v2（stoken=v2_...）: passport-api /account/auth/api/getCookieAccountInfoBySToken?stoken=&mid=
 *                       且要带 x-rpc-app_id: bll8iq97cem8，否则不认。
 * 实测（2026-08）拿 v2 stoken 去问 v1 接口一律 -100，与其死活无关——同一把 stoken 换
 * v2 姿势问就是 retcode=0。现在扫码签出的清一色 v2，早先只走 v1 接口时这函数恒 false，
 * 于是「作用域不对」被兜底成「已过期」，用户反复扫码也修不好。
 */
async function stokenLiveAtPassport(stuid, cookie) {
  const stoken = cookiePart(cookie, 'stoken')
  if (!stuid || !stoken) return false
  const isV2 = stoken.startsWith('v2_')
  const mid = cookiePart(cookie, 'mid')
  // v2 的复核接口以 mid 定位账号，没 mid 问不了，只能按未知处理
  if (isV2 && !mid) return false
  const url = isV2
    ? `https://passport-api.mihoyo.com/account/auth/api/getCookieAccountInfoBySToken?stoken=${encodeURIComponent(stoken)}&mid=${encodeURIComponent(mid)}`
    : `https://api-takumi.mihoyo.com/auth/api/getCookieAccountInfoBySToken?stoken=${encodeURIComponent(stoken)}&uid=${encodeURIComponent(stuid)}`
  const headers = isV2
    ? {
        Cookie: cookie,
        'x-rpc-app_id': 'bll8iq97cem8',
        'x-rpc-client_type': '2',
        'x-rpc-app_version': APP_VERSION,
      }
    : {}
  try {
    const res = await fetch(url, { headers, timeout: 10000 })
    if (!res.ok) return false
    const j = await res.json()
    return Number(j?.retcode) === 0
  } catch (err) {
    log.debug(`[xhh-TL][米游币] passport 复核失败 ${stuid}: ${err?.message}`)
    return false
  }
}

/**
 * 按 passport 复核结果给出对应话术。
 * 传候选列表而非单份：一个 stuid 可能同时有 yaml / gsuid 两份 stoken，只要有一份在
 * passport 是活的，问题就是「社区作用域」而不是「过期」——按单份（且是最后一个失败的
 * 那份）判会把这种情况错报成过期。
 */
async function expiredMsg(stuid, cookies) {
  const list = (Array.isArray(cookies) ? cookies : [cookies]).filter(Boolean)
  for (const ck of list) {
    if (await stokenLiveAtPassport(stuid, ck)) {
      return '当前 stoken 不支持米游币，请重新【#扫码登录】'
    }
  }
  return 'stoken 已过期，请【#扫码登录】'
}

/**
 * 跑一个米游社账号的米游币任务。
 * @param {object} account { stuid, cookie }
 * @param {object} [opts]
 * @param {string[]} [opts.games] 版块，默认 ['gs','sr','zzz']
 * @param {object} [opts.e] 实时事件；有它 + verifyAddr 才能撞码当场过码
 * @param {string} [opts.verifyAddr] 外部打码服务地址
 * @returns {Promise<object>} { code, msg, stuid, before, after, gained, rows }
 *   code: 'ok' 已执行 | 'done' 今日已完成 | 'expired' stoken 失效 | 'fail' 异常
 */
export async function runCoinTask(account, opts = {}) {
  const { games = Object.keys(FORUMS), e = null, verifyAddr = '' } = opts
  const { stuid } = account
  const base = { stuid, before: 0, after: 0, gained: 0, rows: [] }

  if (!stuid || !account.cookie) {
    return { ...base, code: 'expired', msg: '缺少 stoken' }
  }

  const picked = await pickLiveCredential(account)
  const device = picked.device
  const deviceFp = device.fp
  const cookie = picked.cand.cookie
  // 失败话术要按「名下所有候选」复核，不能只看最后一个失败的那份
  const allCookies = accountCandidates(account).map((c) => c.cookie)

  // 1) 先查任务态：已做满直接短路，不发任何任务请求
  const before = picked.missions
  if (!before.ok) {
    // 这里早退时一条任务请求都没发过，下面按版块的 mark 日志一行都不会有。
    // 定时场景（log:false + 汇总图无行则不发）会因此彻底静默，看着像「任务根本没跑」，故必须记一笔。
    if (isExpired(before.res)) {
      log.mark(`[xhh-TL][米游币] ${stuid} 查询任务态失败：stoken 失效`)
      return { ...base, code: 'expired', msg: await expiredMsg(stuid, allCookies) }
    }
    log.mark(
      `[xhh-TL][米游币] ${stuid} 查询任务态失败：retcode=${before.res?.retcode} ${before.res?.message || ''}`,
    )
    return { ...base, code: 'fail', msg: `查询米游币失败：${before.res?.message || '未知错误'}` }
  }
  base.before = before.total
  base.after = before.total
  // states 里带各子任务的完成度，本可用来跳过今天已做满的看帖/点赞/分享（现在是无脑全做）。
  // 要按它短路得先确认 mission_key 的真实取值，猜错会漏做任务，故先只记录不使用。
  log.debug(
    `[xhh-TL][米游币] ${stuid} states: ${JSON.stringify(before.states)}`,
  )
  if (before.canGet === 0) {
    return {
      ...base,
      code: 'done',
      msg: `今日已签到过了，请勿重复签到（当前 ${before.total} 米游币）`,
    }
  }

  // 2) 逐版块做任务
  // 中途 stoken 失效要区别于「跑完了但没赚到」——否则上层只看 code 会报成 “+0 币”
  let diedMidway = false
  for (const game of games) {
    const forum = FORUMS[game]
    if (!forum) continue
    const row = { game, name: forum.name, signed: false, already: false, read: 0, vote: 0, share: 0, err: '' }

    try {
      // 2.1 版块签到（撞码则过码重试一次）
      let signRes = await signForum(cookie, device, deviceFp, forum.gids)
      if (isCaptcha(signRes) && e && verifyAddr) {
        log.mark(`[xhh-TL][米游币] ${stuid} ${forum.name} 撞验证码，尝试过码…`)
        const passed = await runBbsVerify(e, {
          uid: stuid,
          cookie,
          game,
          device,
          deviceFp,
          verifyAddr,
        })
        if (passed) signRes = await signForum(cookie, device, deviceFp, forum.gids)
      }
      if (isExpired(signRes)) {
        row.err = 'stoken 失效'
        base.rows.push(row)
        diedMidway = true
        break
      }
      // -5003 = 今日该版块已签过，算完成但标记出来，避免看着像刚签的
      const rc = Number(signRes?.retcode)
      row.signed = rc === 0 || rc === -5003
      row.already = rc === -5003
      if (row.already) row.err = '已签过'
      else if (!row.signed && isCaptcha(signRes)) row.err = '验证码'
      else if (!row.signed && isBadSign(signRes)) row.err = '签名被拒'
      await jitter()

      // 2.2 拉帖子列表
      const postIds = await getPostList(cookie, device, deviceFp, forum.forumId)
      if (!postIds.length) {
        row.err = row.err || '帖子列表为空'
        base.rows.push(row)
        await jitter()
        continue
      }
      await jitter()

      // 2.3 浏览（只取需求数，不遍历 20 篇）
      for (const postId of postIds.slice(0, NEED_READ)) {
        const res = await readPost(cookie, device, deviceFp, postId)
        if (Number(res?.retcode) === 0) row.read++
        await jitter()
      }

      // 2.4 点赞
      for (const postId of postIds.slice(0, NEED_VOTE)) {
        const res = await votePost(cookie, device, deviceFp, postId)
        if (Number(res?.retcode) === 0) row.vote++
        await jitter()
      }

      // 2.5 分享（官方日上限就 1 次，循环只是与上面写法保持一致）
      for (const postId of postIds.slice(0, NEED_SHARE)) {
        const res = await sharePost(cookie, device, deviceFp, postId)
        if (Number(res?.retcode) === 0) row.share++
        await jitter()
      }

      log.mark(
        `[xhh-TL][米游币] ${stuid} ${forum.name}: 签到${row.signed ? '✓' : '✗'} 浏览${row.read} 点赞${row.vote} 分享${row.share}`,
      )
    } catch (err) {
      row.err = '异常'
      log.error(`[xhh-TL][米游币] ${stuid} ${forum.name} 异常: ${err?.message}`)
    }
    base.rows.push(row)
  }

  // 3) 复查余额，算增量
  // 中途失效就不复查了：这一发必然也是 -100，白白多一次请求
  if (diedMidway) {
    return { ...base, code: 'expired', msg: await expiredMsg(stuid, allCookies) }
  }
  const after = await queryMissions(cookie, device, deviceFp)
  if (after.ok) {
    base.after = after.total
    base.gained = after.total - before.total
  }

  return {
    ...base,
    code: 'ok',
    msg: `获得 ${base.gained} 米游币（当前 ${base.after}）`,
  }
}

/** 只查余额，不做任务 */
export async function queryCoin(account) {
  const { stuid, cookie } = account
  if (!stuid || !cookie) return { ok: false, msg: '缺少 stoken' }
  const { missions: r } = await pickLiveCredential(account)
  if (!r.ok) {
    return {
      ok: false,
      msg: isExpired(r.res)
        ? await expiredMsg(stuid, accountCandidates(account).map((c) => c.cookie))
        : `查询失败：${r.res?.message || '未知错误'}`,
    }
  }
  return { ok: true, total: r.total, canGet: r.canGet }
}

// ============ 账号枚举 ============

function readYaml(file) {
  try {
    if (fs.existsSync(file)) return YAML.parse(fs.readFileSync(file, 'utf-8')) || {}
  } catch (_) {}
  return {}
}

/** gsuid_core 数据库默认位置（按顺序探测，取存在且能读的） */
const GSUID_DB_CANDIDATES = [
  '/opt/gsuid_core/data/GsData.db',
  '/root/gsuid_core/data/GsData.db',
]

function gsuidDbPaths() {
  const custom = config()?.bbs_coin_gsuid_db || ''
  return resolveConfiguredPaths(custom, GSUID_DB_CANDIDATES).filter((file) => {
    try {
      return fs.existsSync(file)
    } catch (err) {
      log.debug(`[xhh-TL][米游币] 检查数据库路径失败 ${file}: ${err?.message || err}`)
      return false
    }
  })
}

/**
 * 从 gsuid_core 的 GsData.db 读 stoken。
 *
 * gsuser 表的 stoken 字段存的就是完整 cookie 串（stuid=..;stoken=..;mid=..;），
 * 另有 fp / device_id / device_info 三个字段是该账号注册过的真实设备，一并带出来复用。
 *
 * status='error' 是 gsuid 自己标记的失效账号，直接跳过（实测这类必定 -100）。
 * 反过来 status 为空不代表一定有效，所以只当负向过滤用。
 *
 * 只读打开（驱动见 utils/sqlite.js），不写、不锁库，不影响正在跑的 gsuid。
 */
async function readGsuidAccounts(qq) {
  const out = []
  const driver = await getSqliteDriver()
  if (!driver) {
    log.error(`[xhh-TL][米游币] ${sqliteUnavailableMessage()}`)
    return out
  }
  const paths = gsuidDbPaths()
  if (!paths.length) return out

  for (const file of paths) {
    try {
      const rows = await withReadonlyDb(file, (db) =>
        db.all(
          `SELECT user_id, mys_id, status, stoken, fp, device_id, device_info
           FROM gsuser
          WHERE user_id = ? AND stoken IS NOT NULL AND stoken != ''`,
          [String(qq)],
        ),
      )
      for (const row of rows || []) {
        if (String(row.status || '').toLowerCase() === 'error') {
          log.debug(`[xhh-TL][米游币] gsuid 账号 ${row.mys_id} 已被标记失效，跳过`)
          continue
        }
        const raw = String(row.stoken || '')
        const stoken = cookiePart(raw, 'stoken') || raw
        const stuid = cookiePart(raw, 'stuid') || String(row.mys_id || '')
        const mid = cookiePart(raw, 'mid')
        if (!stoken || !stuid) continue
        out.push({
          stuid,
          stoken,
          mid,
          fp: row.fp || '',
          device_id: row.device_id || '',
          device_info: row.device_info || '',
        })
      }
    } catch (err) {
      log.error(`[xhh-TL][米游币] 读取 gsuid 库失败 ${file}（${driver.name}）: ${err?.code || err?.name || 'SQLite'}: ${err?.message || err}`)
    }
    if (out.length) break
  }
  return out
}

/**
 * 枚举某 QQ 名下可做米游币任务的米游社账号（按 stuid 去重）。
 *
 * 米游币是「米游社账号」维度，不是游戏 UID 维度：同一账号下多个 UID 只做一次。
 * 存活判定与 auth.js:getstoken 同款：#删除ck 掉的账号判死，但若指纹变了（重新扫码）则自愈放行。
 *
 * @returns {Promise<Array<{stuid, cookie, alts}>>} alts = 同一账号的其它候选凭证
 */
export async function listBbsAccounts(qq, e = null) {
  const out = new Map() // stuid -> { stuid, cookie }

  // Runtime owns the account lifecycle when available. Keep yaml/gsuid as
  // stoken providers, but only for accounts still present in Runtime.
  let runtimeIds = null
  if (hasRuntimeBinding(e)) {
    try {
      const runtimeUser = await createUser(qq, e)
      runtimeIds = new Set(Object.keys(runtimeUser?.mysUsers || {}).map(String))
    } catch (_) {
      runtimeIds = new Set()
    }
  }

  let bind = { hasRow: false, ids: new Set() }
  try {
    bind = await getAliveMysIds(qq)
  } catch (_) {}

  const deletedMap = getDeletedMap(qq)
  const isStillDeleted = (sid, curStoken) => {
    if (!sid || !(sid in deletedMap)) return false
    const oldFp = deletedMap[sid]
    if (oldFp && curStoken) {
      if (fingerprintStoken(curStoken) !== oldFp) {
        removeDeleted(qq, [sid])
        delete deletedMap[sid]
        log.mark(`[xhh-TL][米游币] QQ ${qq} 账号 ${sid} 检测到重新登录，已恢复`)
        return false
      }
    }
    return true
  }

  /**
   * 收下一份候选凭证。
   *
   * 不做「同 stuid 只留第一份」——同一账号可能在 gsuid 库和扫码 yaml 里各存一份 stoken，
   * 且两份未必同时有效（实测旧的会把刚扫码的新的挡死，误报 stoken 失效）。
   * 这里把每份都留着，按 stoken 去重，真伪交给 pickLiveCredential 逐个试。
   */
  const accept = (stuid, stoken, mid, extra = null) => {
    const sid = String(stuid || '')
    if (!sid || !stoken) return
    if (runtimeIds && !runtimeIds.has(sid)) return
    if (isStillDeleted(sid, stoken)) return
    if (bind.hasRow && !bind.ids.has(sid)) return
    let cookie = `stuid=${sid};stoken=${stoken};`
    if (mid) cookie += `mid=${mid};`
    const cred = { cookie, ...(extra || {}) }
    const cur = out.get(sid)
    if (!cur) {
      out.set(sid, { stuid: sid, ...cred, alts: [] })
      return
    }
    // 同 stoken 不重复收
    if (cur.cookie === cookie || cur.alts.some((a) => a.cookie === cookie)) return
    cur.alts.push(cred)
  }

  // 0) stoken yaml 先试：#扫码登录 会把最新 stoken 写在这儿，通常比 gsuid 库里的新。
  //    （实测 bbs 认证与 device_id/fp 无关——换成随便一个假设备也能通——所以「新」比
  //     「带真实设备」更值得优先，gsuid 那份留作后备。）
  for (const file of getStokenCandidateFiles(qq)) {
    const data = readYaml(file)
    for (const entry of Object.values(data || {})) {
      if (!entry || typeof entry !== 'object') continue
      const stoken = entry.stoken || cookiePart(entry.ck_stoken || '', 'stoken')
      const stuid =
        entry.stuid ||
        cookiePart(entry.ck_stoken || '', 'stuid') ||
        cookiePart(entry.ck_stoken || '', 'ltuid') ||
        entry.ltuid
      const mid = entry.mid || cookiePart(entry.ck_stoken || '', 'mid')
      accept(stuid, stoken, mid)
    }
  }

  // 1) gsuid_core 库：另一份 stoken，且带账号注册过的真实 device_id/fp
  for (const acc of await readGsuidAccounts(qq)) {
    accept(acc.stuid, acc.stoken, acc.mid, {
      fp: acc.fp,
      device_id: acc.device_id,
      device_info: acc.device_info,
    })
  }

  // 2) 绑定库兜底：部分账号 stoken 存在 mysUsers 字段或拼在 ck 里
  try {
    const user = await createUser(qq, e)
    for (const [ltuid, mys] of Object.entries(user?.mysUsers || {})) {
      const ck = mys?.ck || ''
      const stoken = typeof mys?.stoken === 'string' && mys.stoken ? mys.stoken : cookiePart(ck, 'stoken')
      if (!stoken) continue
      const stuid = mys?.stuid || cookiePart(ck, 'stuid') || cookiePart(ck, 'account_id') || String(ltuid)
      const mid = typeof mys?.mid === 'string' ? mys.mid : cookiePart(ck, 'mid')
      accept(stuid, stoken, mid)
    }
  } catch (err) {
    log.debug(`[xhh-TL][米游币] 绑定库兜底失败: ${err?.message}`)
  }

  return [...out.values()]
}

export { FORUMS }
export default { runCoinTask, queryCoin, listBbsAccounts, FORUMS }
